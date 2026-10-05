from pathlib import Path
from networkx.readwrite import json_graph
import json
import pandas as pd
import networkx as nx

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

def sort_stops(city_name="cluj"):
    raw_dir = DATA_DIR / "raw" / city_name
    stops = pd.read_csv(raw_dir / "stops.txt")
    stops = stops.dropna(subset=['stop_lat', 'stop_lon'])
    
    stop_times = pd.read_csv(raw_dir / "stop_times.txt")
    stop_times = stop_times.sort_values(by=['trip_id', 'stop_sequence'])
    return stops, stop_times

def time_to_seconds(time_str):
    h, m, s = map(int, str(time_str).split(':'))
    return h * 3600 + m * 60 + s

def create_edges(stop_times):
    edges = stop_times.copy()

    # Init
    edges['next_stop_id'] = edges['stop_id'].shift(-1)
    edges['next_trip_id'] = edges['trip_id'].shift(-1)
    edges['arrival_at_next'] = edges['arrival_time'].shift(-1)

    edges = edges[edges['trip_id'] == edges['next_trip_id']].copy()

    # Travel Time
    edges['departure_sec'] = edges['departure_time'].apply(time_to_seconds)
    edges['arrival_sec'] = edges['arrival_at_next'].apply(time_to_seconds)

    edges['travel_time_seconds'] = edges['arrival_sec'] - edges['departure_sec']
    return edges

def create_graph(stops, edges):
    graph = nx.DiGraph()

    for _, stop in stops.iterrows():
        graph.add_node(
            stop['stop_id'], 
            name=stop['stop_name'], 
            lat=stop['stop_lat'], 
            lon=stop['stop_lon']
        )

    for _, edge in edges.iterrows():
        graph.add_edge(
            edge['stop_id'], 
            edge['next_stop_id'], 
            weight=edge['travel_time_seconds'], 
            trip_id=edge['trip_id']
        )

    return graph

def export_graph(graph, city_name="cluj"):
    processed_dir = DATA_DIR / "processed" / city_name
    processed_dir.mkdir(parents=True, exist_ok=True)

    graph_data = json_graph.node_link_data(graph)

    export_path = processed_dir / "graph.json"
    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(graph_data, f, ensure_ascii=False)

    print(f"Graph successfully exported to {export_path}")

if __name__ == "__main__":
    city_name = "cluj"
    stops, stop_times = sort_stops(city_name)
    edges = create_edges(stop_times)
    graph = create_graph(stops, edges)
    export_graph(graph, city_name)
    
    print(f"Graph created for {city_name} with {graph.number_of_nodes()} nodes and {graph.number_of_edges()} edges.")