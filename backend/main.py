import threading
import time
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from networkx.readwrite import json_graph
from .live import get_live_buses, get_etas_for_stop
import networkx as nx
import json
import csv

BASE_DIR = Path(__file__).resolve().parent.parent
TRIPS_FILE = BASE_DIR / "data" / "raw" / "cluj" / "trips.txt"
SHAPES_FILE = BASE_DIR / "data" / "raw" / "cluj" / "shapes.txt"
ROUTES_FILE = BASE_DIR / "data" / "raw" / "cluj" / "routes.txt"
DATA_DIR = BASE_DIR / "data"

LIVE_DATA_CACHE = {
    "buses": [],
    "last_fetched": 0
}

app = FastAPI(title="Transit Routing API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

bus_memory = {}
shapes_cache = {}
velocity_memory = {}

def load_graph(city_name="cluj"):
    graph_path = DATA_DIR / "processed" / city_name / "graph.json"
    try:
        with open(graph_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return json_graph.node_link_graph(data)
    except FileNotFoundError:
        print(f"Graph JSON not found at {graph_path}. Run transform.py first.")
        return nx.DiGraph()

def load_shapes():
    if not shapes_cache:
        try:
            with open(SHAPES_FILE, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    s_id = row["shape_id"]
                    if s_id not in shapes_cache:
                        shapes_cache[s_id] = []
                    shapes_cache[s_id].append({
                        "lat": float(row["shape_pt_lat"]),
                        "lon": float(row["shape_pt_lon"]),
                        "seq": int(row["shape_pt_sequence"])
                    })
            
            for s_id in shapes_cache:
                shapes_cache[s_id].sort(key=lambda x: x["seq"])
                shapes_cache[s_id] = [[p["lat"], p["lon"]] for p in shapes_cache[s_id]]
        except Exception as e:
            print(f"Failed to load shapes: {e}")

transit_graph = load_graph()

def background_live_updater():
    while True:
        try:
            buses = get_live_buses()
            current_time = time.time()
            
            # Apply EMA Smoothing Filter (1D Pseudo-Kalman)
            for bus in buses:
                trip = bus["trip_id"]
                raw_speed = bus.get("speed_m_s")
                
                if raw_speed is None:
                    raw_speed = 0.0
                    
                if trip in velocity_memory:
                    prev_speed = velocity_memory[trip]
                    if raw_speed > 0:
                        smoothed = (raw_speed * 0.4) + (prev_speed * 0.6)
                    else:
                        smoothed = prev_speed * 0.3
                        if smoothed < 1.0:
                            smoothed = 0.0
                            
                    velocity_memory[trip] = smoothed
                    bus["speed_m_s"] = smoothed
                else:
                    initial_speed = raw_speed if raw_speed > 0 else 5.0
                    velocity_memory[trip] = initial_speed
                    bus["speed_m_s"] = initial_speed

            LIVE_DATA_CACHE["buses"] = buses
            LIVE_DATA_CACHE["last_fetched"] = current_time
            
            for bus in buses:
                trip = bus["trip_id"]
                current_stop = bus.get("stop_id")
                
                if trip in bus_memory:
                    prev_stop = bus_memory[trip].get("stop_id")
                    
                    if prev_stop and current_stop and prev_stop != current_stop:
                        time_taken = bus["timestamp"] - bus_memory[trip]["timestamp"]
                        
                        try:
                            if transit_graph.has_edge(prev_stop, current_stop):
                                edge_data = transit_graph[prev_stop][current_stop]
                                old_weight = edge_data.get("weight", 30)
                                new_weight = (time_taken * 0.7) + (old_weight * 0.3)
                                edge_data["weight"] = new_weight
                                print(f"Traffic Update: {prev_stop} -> {current_stop} now takes {new_weight:.1f}s")
                        except Exception as e:
                            print(f"Failed to update edge weight: {e}")
                
                bus_memory[trip] = bus
                
        except Exception as e:
            print(f"Error in background update: {e}")
        
        time.sleep(5)

threading.Thread(target=background_live_updater, daemon=True).start()

@app.get("/api/stops")
def get_all_stops():
    stops = []
    for node_id, data in transit_graph.nodes(data=True):
        stops.append({
            "id": node_id,
            "name": data.get("name"),
            "lat": data.get("lat"),
            "lon": data.get("lon")
        })
    return {"stops": stops}

@app.get("/api/route")
def get_fastest_route(start_stop: str, end_stop: str):
    try:
        path = nx.shortest_path(transit_graph, source=start_stop, target=end_stop, weight="weight")
        return {"route": path}
    except nx.NetworkXNoPath:
        raise HTTPException(status_code=404, detail="No route possible between these stops.")
    except nx.NodeNotFound:
        raise HTTPException(status_code=400, detail="Invalid stop ID provided.")

@app.get("/api/live_buses")
def api_get_live_buses(route_name: Optional[str] = None):
    buses = LIVE_DATA_CACHE["buses"]
    if route_name:
        filtered_buses = [
            b for b in buses 
            if str(b.get("route_name", "")).lower() == route_name.lower()
        ]
        return {"buses": filtered_buses}
    return {"buses": buses}

@app.get("/api/etas")
def api_get_etas(stop_id: str):
    if not stop_id:
        raise HTTPException(status_code=400, detail="Missing stop_id")
    etas = get_etas_for_stop(stop_id)
    return {"stop_id": stop_id, "etas": etas}

@app.get("/api/shapes/{shape_id}")
def get_shape(shape_id: str):
    if not shapes_cache:
        load_shapes()
    if shape_id not in shapes_cache:
        raise HTTPException(status_code=404, detail="Shape not found")
    return {"shape": shapes_cache[shape_id]}

@app.get("/api/route_shapes/{route_name}")
def get_route_shapes(route_name: str):
    if not shapes_cache:
        load_shapes()
        
    matched_route_ids = set()
    try:
        with open(ROUTES_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row["route_short_name"].lower() == route_name.lower():
                    matched_route_ids.add(row["route_id"])
    except Exception as e:
        print(f"Error reading routes.txt: {e}")
        
    shape_directions = {}
    try:
        with open(TRIPS_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row["route_id"] in matched_route_ids:
                    dir_id_str = row.get("direction_id", "0")
                    dir_id = int(dir_id_str) if dir_id_str.isdigit() else 0
                    shape_directions[row["shape_id"]] = dir_id
    except Exception as e:
        print(f"Error reading trips.txt: {e}")
        
    result = []
    for s_id, dir_id in shape_directions.items():
        if s_id in shapes_cache:
            result.append({
                "shape": shapes_cache[s_id],
                "direction_id": dir_id
            })
            
    return {"shapes": result}