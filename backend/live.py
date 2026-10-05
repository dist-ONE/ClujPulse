from google.transit import gtfs_realtime_pb2
from pathlib import Path
import requests
import time
import csv

URL = "https://cluj-rt-feed.gtfs.ro/vehiclePositions"
BASE_DIR = Path(__file__).resolve().parent.parent
TRIPS_FILE = BASE_DIR / "data" / "raw" / "cluj" / "trips.txt"
ROUTES_FILE = BASE_DIR / "data" / "raw" / "cluj" / "routes.txt"
TRIP_UPDATES_URL = "https://cluj-rt-feed.gtfs.ro/tripUpdates"
STOP_TIMES_FILE = BASE_DIR / "data" / "raw" / "cluj" / "stop_times.txt"

routes_cache = {}
trips_cache = {}
stop_routes_cache = {}
route_to_shape_cache = {}

def load_routes():
    if not routes_cache:
        try:
            with open(ROUTES_FILE, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    routes_cache[row["route_id"]] = row["route_short_name"]
        except Exception as e:
            print(f"Failed to load routes.txt: {e}")

def load_trips():
    if not trips_cache:
        try:
            with open(TRIPS_FILE, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    dir_id_str = row.get("direction_id", "0")
                    dir_id = int(dir_id_str) if dir_id_str.isdigit() else 0
                    
                    trips_cache[row["trip_id"]] = {
                        "shape_id": row["shape_id"],
                        "direction_id": dir_id,
                        "route_id": row["route_id"]
                    }

                    if row["route_id"] not in route_to_shape_cache:
                        route_to_shape_cache[row["route_id"]] = row["shape_id"]
        except Exception as e:
            print(f"Failed to load trips.txt: {e}")

def load_stop_routes():
    if not stop_routes_cache:
        load_routes()
        load_trips()
        try:
            with open(STOP_TIMES_FILE, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    stop_id = row["stop_id"]
                    trip_id = row["trip_id"]
                    
                    trip_data = trips_cache.get(trip_id)
                    if trip_data and "route_id" in trip_data:
                        r_id = trip_data["route_id"]
                        r_name = routes_cache.get(r_id, r_id)
                        
                        if stop_id not in stop_routes_cache:
                            stop_routes_cache[stop_id] = set()
                        stop_routes_cache[stop_id].add(r_name)
        except Exception as e:
            print(f"Failed to load stop_times.txt: {e}")

def get_live_buses():
    load_routes()
    load_trips()

    try:
        response = requests.get(URL, timeout=10) 
        if response.status_code != 200:
            return []
            
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(response.content)

        trip_etas = {}
        try:
            tu_resp = requests.get(TRIP_UPDATES_URL, timeout=10)
            if tu_resp.status_code == 200:
                tu_feed = gtfs_realtime_pb2.FeedMessage()
                tu_feed.ParseFromString(tu_resp.content)
                current_time = int(time.time())
                
                for entity in tu_feed.entity:
                    if entity.HasField('trip_update'):
                        trip_id = entity.trip_update.trip.trip_id
                        for stop_update in entity.trip_update.stop_time_update:
                            if stop_update.HasField('arrival') and stop_update.arrival.HasField('time'):
                                eta_seconds = stop_update.arrival.time - current_time
                                if eta_seconds > 0:
                                    trip_etas[trip_id] = eta_seconds * 1000
                                    break
        except Exception as e:
            print(f"Failed to fetch TripUpdates for live sync: {e}")
        
        live_buses = []
        for entity in feed.entity:
            if entity.HasField('vehicle'):
                vehicle = entity.vehicle
                
                route_id = vehicle.trip.route_id
                if not route_id and vehicle.trip.trip_id:
                    route_id = vehicle.trip.trip_id.split('_')[0]
                route_name = routes_cache.get(route_id, route_id)

                trip_id = vehicle.trip.trip_id
                time_to_next_stop_ms = trip_etas.get(trip_id, 16000)
                
                trip_data = trips_cache.get(trip_id, {})
                shape_id = trip_data.get("shape_id")
                static_direction = trip_data.get("direction_id", 0)

                if not shape_id:
                    shape_id = route_to_shape_cache.get(route_id, "")
                
                live_buses.append({
                    "trip_id": trip_id,
                    "vehicle_id": vehicle.vehicle.id,
                    "route_name": route_name,
                    "shape_id": shape_id,
                    "direction_id": static_direction,
                    "lat": vehicle.position.latitude,
                    "lon": vehicle.position.longitude,
                    "speed_m_s": vehicle.position.speed, 
                    "bearing": vehicle.position.bearing,
                    "stop_id": vehicle.stop_id,
                    "timestamp": vehicle.timestamp,
                    "time_to_next_stop_ms": time_to_next_stop_ms
                })
                
        return live_buses
    except Exception as e:
        print(f"Error fetching live data: {e}")
        return []

def get_etas_for_stop(target_stop_id: str):
    load_routes()
    try:
        response = requests.get(TRIP_UPDATES_URL, timeout=10)
        if response.status_code != 200:
            return []
            
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(response.content)
        
        current_time = int(time.time())
        upcoming_buses = []
        
        for entity in feed.entity:
            if entity.HasField('trip_update'):
                trip = entity.trip_update.trip
                for stop_update in entity.trip_update.stop_time_update:
                    if stop_update.stop_id == target_stop_id:
                        if stop_update.HasField('arrival') and stop_update.arrival.HasField('time'):
                            arrival_timestamp = stop_update.arrival.time
                            eta_seconds = arrival_timestamp - current_time
                            
                            if eta_seconds > 0:
                                route_id = trip.route_id
                                if not route_id and trip.trip_id:
                                    route_id = str(trip.trip_id).split('_')[0]

                                route_name = routes_cache.get(str(route_id), str(route_id)) if route_id else "Unknown"

                                upcoming_buses.append({
                                    "route_name": route_name,
                                    "trip_id": trip.trip_id,
                                    "eta_minutes": round(eta_seconds / 60),
                                    "eta_seconds": eta_seconds
                                })
        
        upcoming_buses.sort(key=lambda x: x["eta_seconds"])
        
        final_buses = []
        known_buses = [b for b in upcoming_buses if b["route_name"] != "Unknown"]
        unknown_buses = [b for b in upcoming_buses if b["route_name"] == "Unknown"]
        
        final_buses.extend(known_buses)
        
        for unk in unknown_buses:
            is_duplicate = False
            for known in known_buses:
                if abs(unk["eta_seconds"] - known["eta_seconds"]) < 60:
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                final_buses.append(unk)
                
        final_buses.sort(key=lambda x: x["eta_seconds"])
        
        load_stop_routes()
        static_routes = stop_routes_cache.get(target_stop_id, set())
        live_routes = {b["route_name"] for b in final_buses}
        
        for r in static_routes:
            if r not in live_routes:
                final_buses.append({
                    "route_name": r,
                    "trip_id": None,
                    "eta_minutes": "60+",
                    "eta_seconds": 999999
                })
                
        return final_buses
        
    except Exception as e:
        print(f"Error fetching trip updates: {e}")
        return []