# ClujPulse

A real-time public transit tracking application that maps live bus locations, calculates ETAs, and visualizes route shapes. 

Instead of dealing with clunky static schedules, this platform continuously consumes GTFS-Realtime feeds, smoothly interpolating vehicle movements on a web map and actively adjusting edge weights in a transit graph based on live traffic delays.

## Features

* **Smooth Live Tracking:** Maps vehicle coordinates on a Leaflet frontend, utilizing a custom 1D projection algorithm to smoothly animate buses along transit shapes between GTFS polling intervals.
* **Smart Off-Route Snapping:** Integrates with a local OSRM routing engine. If a bus drifts significantly from its static GTFS polyline, the system automatically falls back to road-based pathfinding to represent detours.
* **Real-Time ETAs & Stop Data:** Click on any transit stop to fetch up-to-the-minute arrival times calculated directly from GTFS TripUpdates.
* **Traffic-Aware Routing Engine:** Uses an Exponential Moving Average (EMA) filter to track live bus velocities and dynamically adjusts traversal weights in a NetworkX graph, enabling highly accurate point-to-point routing.
* **Route Filtering:** Instantly isolate specific bus lines, view their directional polylines, and track only the vehicles assigned to that route.

## Prerequisites

1. **Python 3.9+**
2. **Docker & Docker Compose** (for running the OSRM backend container)
3. Raw GTFS data files (agency, routes, shapes, stop_times, stops, trips) placed in the `data/raw/cluj` directory.

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/ClujPulse.git
   cd ClujPulse
   ```

2. Set up your Python virtual environment and install dependencies:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows use: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Spin up the OSRM routing engine via Docker:
   ```bash
   docker-compose up -d
   ```

4. Process the raw GTFS data into the routing graph:
   ```bash
   python etl/transform.py
   ```

## Usage

1. **Start the FastAPI Backend:**
   Run the backend server to begin consuming live GTFS-RT feeds.
   ```bash
   uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
   ```
2. **Launch the Visualizer:**
   Open `frontend/index.html` in your web browser (or serve it via a lightweight HTTP server) to view the live map.
3. **Filter and Navigate:**
   Use the control panel in the top right to filter by specific line numbers, or click on bus stops to view live arrival times.

## How it Works (Under the Hood)

1. **Data Ingestion:** The `live.py` module continuously polls external GTFS-Realtime endpoints for `VehiclePositions` and `TripUpdates`, matching them against cached static GTFS shapes.
2. **State Management:** The backend maintains a live memory pool of bus velocities and locations. It compares timestamps between stops to update a NetworkX directed graph with live traffic weights.
3. **Frontend Interpolation:** `map_visualizer.js` pulls the state from the FastAPI endpoints. Instead of jumping from point to point, `simulateTravel()` calculates the distance the bus should have covered since the last ping and projects it forward along the 1D polyline shape.
4. **Deviation Handling:** If a bus's GPS drifts beyond 250 meters from its scheduled path, the frontend queries the local OSRM container to draw a dynamic road-based path to its current location.