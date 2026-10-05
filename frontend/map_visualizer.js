const map = L.map('map').setView([46.770439, 23.591423], 13);
const activeBuses = new Map();
const busLayer = L.layerGroup().addTo(map);

let currentRouteFilter = null;
let popupJustClosed = false;
let fetchInterval = null;

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
}).addTo(map);

const routeControl = L.control({position: 'topright'});
const routeLinesLayer = L.layerGroup().addTo(map);
const shapeCache = new Map();
const globalStops = [];

map.createPane('routePane');
map.getPane('routePane').style.zIndex = 350;

map.createPane('stopPane');
map.getPane('stopPane').style.zIndex = 400; 

map.createPane('busPane');
map.getPane('busPane').style.zIndex = 450; 

map.on('popupclose', function() {
    popupJustClosed = true;
    
    setTimeout(() => {
        popupJustClosed = false;
    }, 50);
});

map.on('click', function() {
    if (popupJustClosed) return;

    if (currentRouteFilter) {
        document.getElementById('routeInput').value = '';
        currentRouteFilter = null;
        updateFetchInterval();
        routeLinesLayer.clearLayers();
        fetchLiveBuses();
    }
});

routeControl.onAdd = function (map) {
    const div = L.DomUtil.create('div', 'route-filter-control');
    div.style.backgroundColor = 'white';
    div.style.padding = '10px';
    div.style.borderRadius = '5px';
    div.style.border = '2px solid rgba(0,0,0,0.2)';
    div.style.fontFamily = 'sans-serif';
    
    div.innerHTML = `
        <label style="font-weight:bold;" for="routeInput">Filter Line:</label><br>
        <input type="text" id="routeInput" placeholder="e.g. 25" style="width: 100px; margin-top: 5px; margin-bottom: 5px;"><br>
        <button id="applyRouteBtn" style="cursor:pointer;">Apply</button>
        <button id="clearRouteBtn" style="cursor:pointer;">Clear</button>
    `;
    L.DomEvent.disableClickPropagation(div);
    return div;
};
routeControl.addTo(map);

document.getElementById('applyRouteBtn').addEventListener('click', () => {
    const val = document.getElementById('routeInput').value.trim();
    if (val) {
        currentRouteFilter = val;
        updateFetchInterval();
        drawRouteLines(currentRouteFilter, true);
        fetchLiveBuses();
    }
});

document.getElementById('clearRouteBtn').addEventListener('click', () => {
    document.getElementById('routeInput').value = '';
    currentRouteFilter = null;
    updateFetchInterval();
    routeLinesLayer.clearLayers();
    fetchLiveBuses();
});

window.filterToLine = function(routeName) {
    document.getElementById('routeInput').value = routeName;
    document.getElementById('applyRouteBtn').click();
};

function projectPointOnSegment(p, a, b) {
    const dx = b[1] - a[1];
    const dy = b[0] - a[0];
    if (dx === 0 && dy === 0) return 0;
    
    const latMid = (a[0] + b[0]) / 2;
    const mPerDegLat = 111320;
    const mPerDegLon = 40075000 * Math.cos(latMid * Math.PI / 180) / 360;
    
    const px = (p[1] - a[1]) * mPerDegLon;
    const py = (p[0] - a[0]) * mPerDegLat;
    const sx = dx * mPerDegLon;
    const sy = dy * mPerDegLat;
    
    const dot = px * sx + py * sy;
    const lenSq = sx * sx + sy * sy;
    
    let param = lenSq === 0 ? 0 : dot / lenSq;
    if (isNaN(param)) param = 0;
    
    return Math.max(0, Math.min(1, param));
}

function get1DRoutePosition(shape, distances, lat, lon, bearing = null) {
    let minDist = Infinity;
    let best1DDistance = 0;
    let bestDistToRoute = Infinity;

    for (let i = 0; i < shape.length - 1; i++) {
        const a = shape[i];
        const b = shape[i+1];
        const p = [lat, lon];
        
        const t = projectPointOnSegment(p, a, b);
        const projLat = a[0] + t * (b[0] - a[0]);
        const projLon = a[1] + t * (b[1] - a[1]);
        
        const distToSegment = map.distance(p, [projLat, projLon]);
        let penalty = 1;

        if (bearing !== null && bearing !== 0 && i < shape.length - 1) {
            const lat1 = a[0] * Math.PI / 180;
            const lon1 = a[1] * Math.PI / 180;
            const lat2 = b[0] * Math.PI / 180;
            const lon2 = b[1] * Math.PI / 180;
            
            const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
            const segBearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
            
            let diff = Math.abs(bearing - segBearing);
            if (diff > 180) diff = 360 - diff;
            if (diff > 90) penalty = 10;
        }

        if (distToSegment * penalty < minDist) {
            minDist = distToSegment * penalty;
            bestDistToRoute = distToSegment;
            const segLength = distances[i+1] - distances[i];
            best1DDistance = distances[i] + (t * segLength);
        }
    }
    return { distance1D: best1DDistance, distToRoute: bestDistToRoute };
}

function getCoordAtDistance(shape, distances, targetDist) {
    if (targetDist <= 0) return shape[0];
    if (targetDist >= distances[distances.length - 1]) return shape[shape.length - 1];
    
    let lower = 0;
    while (lower < distances.length - 2 && distances[lower + 1] <= targetDist) {
        lower++;
    }
    
    const startDist = distances[lower];
    const endDist = distances[lower + 1];
    const segLen = endDist - startDist;
    const alpha = segLen > 0 ? (targetDist - startDist) / segLen : 0;
    
    const a = shape[lower];
    const b = shape[lower + 1];
    return [
        a[0] + (b[0] - a[0]) * alpha,
        a[1] + (b[1] - a[1]) * alpha
    ];
}

async function getShape(shapeId) {
    if (!shapeId) return null;
    if (shapeCache.has(shapeId)) return shapeCache.get(shapeId);
    try {
        const res = await fetch(`http://127.0.0.1:8000/api/shapes/${shapeId}`);
        if (!res.ok) return null;
        const data = await res.json();
        
        const shape = data.shape;
        const distances = [0];
        let total = 0;
        for (let i = 0; i < shape.length - 1; i++) {
            total += map.distance(shape[i], shape[i+1]);
            distances.push(total);
        }
        
        const shapeStops = [];
        globalStops.forEach(stop => {
            const pos = get1DRoutePosition(shape, distances, stop.lat, stop.lon);
            if (pos.distToRoute < 20) {
                let lower = 0;
                while (lower < distances.length - 2 && distances[lower + 1] <= pos.distance1D) lower++;
                
                const a = shape[lower];
                const b = shape[lower + 1];
                
                const dx = b[1] - a[1]; 
                const dy = b[0] - a[0];
                const sx = stop.lon - a[1];
                const sy = stop.lat - a[0];
                
                const cross = (dx * sy) - (dy * sx);
                if (cross <= 0.00005) {
                    shapeStops.push(pos.distance1D);
                }
            }
        });
        
        shapeStops.sort((a, b) => a - b);
        const cacheData = { shape, distances, totalLength: total, stops: shapeStops };
        shapeCache.set(shapeId, cacheData);
        return cacheData;
    } catch (e) {
        return null;
    }
}

async function drawRouteLines(routeName, clearLayers = true) {
    if (clearLayers) routeLinesLayer.clearLayers();
    if (!routeName) return;
    try {
        const res = await fetch(`http://127.0.0.1:8000/api/route_shapes/${encodeURIComponent(routeName)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.shapes) {
            data.shapes.forEach(shapeObj => {
                const lineColor = shapeObj.direction_id === 1 ? '#cc0000' : '#0066cc';
                L.polyline(shapeObj.shape, { 
                    color: lineColor, 
                    weight: 5, 
                    opacity: 0.5, 
                    pane: 'routePane'
                }).addTo(routeLinesLayer);
            });
        }
    } catch (error) {
        console.error("Error fetching route shapes:", error);
    }
}

function updateFetchInterval() {
    if (fetchInterval) clearInterval(fetchInterval);
    const rate = currentRouteFilter ? 5000 : 5000;
    fetchInterval = setInterval(fetchLiveBuses, rate);
}

async function renderTransitStops() {
    try {
        const response = await fetch('http://127.0.0.1:8000/api/stops');
        const data = await response.json();
        
        data.stops.forEach(stop => {
            globalStops.push(stop);
            const marker = L.circleMarker([stop.lat, stop.lon], {
                radius: 5, fillColor: "#3388ff", color: "#000", weight: 1, fillOpacity: 0.8
            }).addTo(map);

            marker.on('click', function(e) {
                L.DomEvent.stopPropagation(e.originalEvent);
            });

            marker.bindPopup(`<div id="popup-${stop.id}" style="min-width: 150px;"><b>${stop.name}</b><br>Loading...</div>`); 
            
            marker.on('popupopen', async () => {
                const popupNode = document.getElementById(`popup-${stop.id}`);
                if (!popupNode) return;
                try {
                    const res = await fetch(`http://127.0.0.1:8000/api/etas?stop_id=${stop.id}`);
                    const etaData = await res.json();
                    
                    const uniqueRoutes = new Set();
                    etaData.etas.forEach(bus => {
                        if (bus.route_name && bus.route_name !== "Unknown") {
                            uniqueRoutes.add(bus.route_name);
                        }
                    });

                    routeLinesLayer.clearLayers();
                    uniqueRoutes.forEach(routeName => {
                        drawRouteLines(routeName, false);
                    });

                    let html = `<b>${stop.name}</b><br><hr style="margin: 5px 0;">`;
                    if (etaData.etas.length === 0) {
                        html += `<i>No upcoming buses.</i>`;
                    } else {
                        etaData.etas.slice(0, 10).forEach(bus => {
                            let timeText = bus.eta_minutes;
                            if (typeof bus.eta_minutes === 'number') {
                                timeText = bus.eta_minutes === 0 ? "Due" : `${bus.eta_minutes} min`;
                            }
                            
                            const safeRouteName = bus.route_name || "Unknown";
                            
                            html += `<div style="margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
                                <button onclick="filterToLine('${safeRouteName}')" 
                                        style="cursor:pointer; padding: 2px 6px; background: #0066cc; color: white; border: none; border-radius: 3px; font-size: 0.85em;">
                                    Line ${safeRouteName}
                                </button>
                                <span style="font-size: 0.9em; margin-left: 10px;">${timeText}</span>
                            </div>`;
                        });
                    }
                    popupNode.innerHTML = html;
                } catch (error) {
                    popupNode.innerHTML = `<b>${stop.name}</b><br><span style="color:red;">Error loading data</span>`;
                }
            });
        });
    } catch (error) {
        console.error("Error fetching transit data:", error);
    }
}

async function getRoadPath(startLat, startLon, endLat, endLon) {
    if (Math.abs(startLat - endLat) < 0.0001 && Math.abs(startLon - endLon) < 0.0001) {
        return [[startLat, startLon], [endLat, endLon]];
    }
    const url = `http://127.0.0.1:5000/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson`;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("CORS or network error");
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
            return data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
        }
    } catch (e) {
        return [[startLat, startLon], [endLat, endLon]];
    }
    return [[startLat, startLon], [endLat, endLon]];
}

async function drawRouteLines(routeName, clearLayers = true) {
    if (clearLayers) routeLinesLayer.clearLayers();
    if (!routeName) return;
    try {
        const res = await fetch(`http://127.0.0.1:8000/api/route_shapes/${encodeURIComponent(routeName)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.shapes) {
            data.shapes.forEach(shapeObj => {
                const lineColor = shapeObj.direction_id === 1 ? '#cc0000' : '#0066cc';
                L.polyline(shapeObj.shape, { color: lineColor, weight: 5, opacity: 0.5 }).addTo(routeLinesLayer);
            });
        }
    } catch (error) {
        console.error("Error fetching route shapes:", error);
    }
}

async function setupOffRoute(busData, bus, cLat, cLon) {
    busData.is1D = false;
    busData.offRoutePath = await getRoadPath(cLat, cLon, bus.lat, bus.lon);
    
    let totalDistance = 0;
    let distances = [0];
    for (let i = 0; i < busData.offRoutePath.length - 1; i++) {
        totalDistance += map.distance(busData.offRoutePath[i], busData.offRoutePath[i+1]);
        distances.push(totalDistance);
    }
    busData.offRouteDistances = distances;
    busData.offRouteTotalDistance = totalDistance;
    busData.offRouteStartTime = performance.now();
}

function updateBusPath(busData, bus, currentPos) {
    const cLat = currentPos.lat !== undefined ? currentPos.lat : currentPos[0];
    const cLon = currentPos.lng !== undefined ? currentPos.lng : currentPos[1];

    getShape(bus.shape_id).then(async (shapeData) => {
        if (shapeData && shapeData.shape.length > 0) {
            const currentUnixTime = Math.floor(Date.now() / 1000);
            let dataAgeSec = currentUnixTime - bus.timestamp;
            if (dataAgeSec < 0) dataAgeSec = 0;
            if (dataAgeSec > 20) dataAgeSec = 20;

            const { distance1D, distToRoute } = get1DRoutePosition(shapeData.shape, shapeData.distances, bus.lat, bus.lon, bus.bearing);
            
            if (distToRoute > 300) {
                if (busLayer.hasLayer(busData.marker)) busLayer.removeLayer(busData.marker);
                busData.isHidden = true;
                return;
            } else if (busData.isHidden) {
                if (!busLayer.hasLayer(busData.marker)) busLayer.addLayer(busData.marker);
                busData.isHidden = false;
            }

            if (distToRoute > 250) {
                await setupOffRoute(busData, bus, cLat, cLon);
            } else {
                busData.is1D = true;
                busData.shapeData = shapeData;

                busData.lastGpsDistance = distance1D; 
                busData.targetDistance = distance1D + (busData.speed_m_s * dataAgeSec);
                
                if (busData.currentDistance === undefined || Math.abs(busData.targetDistance - busData.currentDistance) > 500) {
                    busData.currentDistance = busData.targetDistance;
                }
            }
        } else {
            await setupOffRoute(busData, bus, cLat, cLon);
        }
    }).catch(async () => {
        await setupOffRoute(busData, bus, cLat, cLon);
    });
}

async function fetchLiveBuses() {
    try {
        const response = await fetch('http://127.0.0.1:8000/api/live_buses');
        const data = await response.json();
        const currentActiveIds = new Set();
        const currentTime = performance.now();

        data.buses.forEach(bus => {
            const busId = (bus.vehicle_id && bus.vehicle_id !== "") ? bus.vehicle_id : bus.trip_id;
            if (!busId) return; 

            currentActiveIds.add(busId);
            const displayName = bus.route_name ? bus.route_name : busId;
            const isVisible = !currentRouteFilter || (bus.route_name && bus.route_name.toLowerCase() === currentRouteFilter.toLowerCase());
            
            const speedKmh = Math.round((bus.speed_m_s || 0) * 3.6);
            const dirText = bus.direction_id === 1 ? "Retur" : "Tur";
            const vehicleCode = bus.vehicle_id ? bus.vehicle_id : "N/A";
            
            let isStopped = false; 
            let busData = activeBuses.get(busId);

            if (busData) {
                if (busData.targetLat !== bus.lat || busData.targetLon !== bus.lon) {
                    busData.lastMovedTime = currentTime;
                }
                
                const timeSinceLastMove = currentTime - (busData.lastMovedTime || currentTime);
                const isStale = timeSinceLastMove > 420000;

                if (timeSinceLastMove > 300000) isStopped = true;

                let isAtStation = false;
                if (isStopped && !isStale && busData.is1D) {
                    const currentPhysicalCoord = busData.marker.getLatLng();
                    for (const stop of globalStops) {
                        if (map.distance([currentPhysicalCoord.lat, currentPhysicalCoord.lng], [stop.lat, stop.lon]) < 30) {
                            isAtStation = true;
                            break;
                        }
                    }
                }

                const statusText = isStale ? `Connection Lost` : (isAtStation ? "Stopped at Station" : (isStopped ? "Stopped in Traffic" : "Moving"));
                const markerColor = isStale ? "#808080" : (isAtStation ? "#ff9900" : "#ff0000");
                const popupHtml = `<b>Bus ${displayName} (Code: ${vehicleCode})</b><br>Dir: ${dirText}<br>Speed: ${speedKmh} km/h<br>Status: ${statusText}`;

                if (isVisible && !busData.isHidden) {
                    if (!busLayer.hasLayer(busData.marker)) busLayer.addLayer(busData.marker);
                    busData.marker.setStyle({ fillColor: markerColor });
                    
                    if (!busData.stopTimer || busData.stopTimer <= 0) {
                        busData.marker.setPopupContent(popupHtml);
                    }
                } else {
                    if (busLayer.hasLayer(busData.marker)) busLayer.removeLayer(busData.marker);
                }

                if (busData.targetLat !== bus.lat || busData.targetLon !== bus.lon) {
                    busData.displayName = displayName;
                    busData.vehicleCode = vehicleCode;
                    busData.dirText = dirText;
                    busData.statusText = statusText;
                    busData.targetLat = bus.lat;
                    busData.targetLon = bus.lon;
                    busData.timestamp = bus.timestamp;
                    busData.speed_m_s = (bus.speed_m_s !== null && bus.speed_m_s !== undefined) ? bus.speed_m_s : 5;
                    
                    updateBusPath(busData, bus, busData.marker.getLatLng());
                }
            } else {
                const markerColor = "#ff0000";
                const popupHtml = `<b>Bus ${displayName} (Code: ${vehicleCode})</b><br>Dir: ${dirText}<br>Speed: ${speedKmh} km/h<br>Status: Moving`;
                const marker = L.circleMarker([bus.lat, bus.lon], {
                    radius: 7, fillColor: markerColor, color: "#ffffff", weight: 2, fillOpacity: 1.0,
                    pane: 'busPane'
                }).bindPopup(popupHtml);

                marker.on('click', () => {
                    if (bus.route_name) {
                        window.filterToLine(bus.route_name);
                    }
                });

                if (isVisible) marker.addTo(busLayer);

                const newBusData = {
                    marker: marker,
                    targetLat: bus.lat, 
                    targetLon: bus.lon,
                    timestamp: bus.timestamp,
                    speed_m_s: (bus.speed_m_s > 0) ? bus.speed_m_s : 5,
                    lastMovedTime: currentTime,
                    lastFrameTime: currentTime,
                    basePopupHtml: popupHtml,
                    stopTimer: 0,
                    lastStoppedDist: -100,
                    is1D: false,
                    isHidden: false,
                    displayName: displayName,
                    vehicleCode: vehicleCode,
                    dirText: dirText,
                    statusText: "Moving"
                };
                activeBuses.set(busId, newBusData);

                updateBusPath(newBusData, bus, [bus.lat, bus.lon]);
            }
        });

        for (const activeId of activeBuses.keys()) {
            if (!currentActiveIds.has(activeId)) {
                const bData = activeBuses.get(activeId);
                if (busLayer.hasLayer(bData.marker)) busLayer.removeLayer(bData.marker);
                activeBuses.delete(activeId);
            }
        }
    } catch (error) {
        console.error("Error fetching live buses:", error);
    }
}

function simulateTravel(currentTime) {
    activeBuses.forEach((busData) => {
        const deltaTime = currentTime - (busData.lastFrameTime || currentTime);
        busData.lastFrameTime = currentTime;

        const timeSinceLastMove = currentTime - (busData.lastMovedTime || currentTime);
        if (timeSinceLastMove > 300000) return;

        if (busData.is1D && busData.shapeData && !busData.isHidden) {
            const speed = busData.speed_m_s !== undefined ? busData.speed_m_s : 5;
            const deltaSec = deltaTime / 1000;
            
            let visualSpeed = speed; 
            
            busData.targetDistance += (speed * deltaSec);
            if (busData.targetDistance > busData.shapeData.totalLength) {
                busData.targetDistance = busData.shapeData.totalLength;
            }

            if (busData.stopTimer > 0) {
                busData.stopTimer -= deltaTime;
                visualSpeed = 0; 
                if (busData.basePopupHtml) {
                    busData.marker.setPopupContent(busData.basePopupHtml.replace("Status: Moving", "Status: Boarding at Station"));
                }
                
            } else {
                if (busData.basePopupHtml && busData.marker.getPopup().getContent().includes("Boarding")) {
                    busData.marker.setPopupContent(busData.basePopupHtml);
                }

                let distDiff = busData.targetDistance - busData.currentDistance;
                
                if (distDiff > 400) {
                    busData.currentDistance = busData.targetDistance;
                    visualSpeed = speed;
                } else if (distDiff > 100) {
                    visualSpeed = speed * 1.5;
                } else if (distDiff > 20) {
                    visualSpeed = speed * 1.2;
                } else if (distDiff < -15) {
                    visualSpeed = 0;
                } else {
                    visualSpeed = speed;
                }

                if (busData.lastGpsDistance !== undefined && busData.currentDistance >= busData.lastGpsDistance) {
                    if (visualSpeed > speed) {
                        visualSpeed = speed; 
                    }
                }

                const nextDistance = busData.currentDistance + (visualSpeed * deltaSec);
                let crossedStop = false;

                if (busData.shapeData.stops) {
                    for (let sDist of busData.shapeData.stops) {
                        if (sDist > busData.currentDistance && sDist <= nextDistance) {
                            if (Math.abs(busData.lastStoppedDist - sDist) > 50) {
                                busData.currentDistance = sDist;
                                
                                if (distDiff > 100) {
                                    busData.stopTimer = 3000;
                                } else {
                                    busData.stopTimer = 12000;
                                }
                                
                                busData.lastStoppedDist = sDist;
                                crossedStop = true;
                                visualSpeed = 0; 
                                break;
                            }
                        }
                    }
                }

                if (!crossedStop) {
                    busData.currentDistance = nextDistance;
                }

                if (busData.currentDistance > busData.shapeData.totalLength) {
                    busData.currentDistance = busData.shapeData.totalLength;
                }

                const newCoord = getCoordAtDistance(busData.shapeData.shape, busData.shapeData.distances, busData.currentDistance);
                busData.marker.setLatLng(newCoord);
            }

            let displaySpeed = Math.round(visualSpeed * 3.6);
            let currentStatus = busData.statusText;

            if (busData.stopTimer > 0) {
                displaySpeed = 0;
                currentStatus = "Boarding at Station";
            } else if (visualSpeed === 0 && currentStatus === "Moving") {
                displaySpeed = 0;
                currentStatus = "Waiting for Sync";
            }

            const popupHtml = `<b>Bus ${busData.displayName} (Code: ${busData.vehicleCode})</b><br>Dir: ${busData.dirText}<br>Speed: ${displaySpeed} km/h<br>Status: ${currentStatus}`;
            
            if (busData.marker.isPopupOpen() && busData.lastPopupHtml !== popupHtml) {
                busData.marker.setPopupContent(popupHtml);
                busData.lastPopupHtml = popupHtml;
            }
            
            busData.basePopupHtml = popupHtml;

        } else if (!busData.is1D && busData.offRoutePath && busData.offRouteDistances && !busData.isHidden) {
            if (busData.offRoutePath.length < 2) {
                if (busData.offRoutePath.length === 1) {
                    busData.marker.setLatLng(busData.offRoutePath[0]);
                }
                return;
            }

            const speed = busData.speed_m_s || 5;
            const timeSinceStart = currentTime - busData.offRouteStartTime;
            let targetDistance = (timeSinceStart / 1000) * speed;
            
            if (targetDistance > busData.offRouteTotalDistance) targetDistance = busData.offRouteTotalDistance;

            let lowerIndex = 0;
            while (lowerIndex < busData.offRouteDistances.length - 2 && busData.offRouteDistances[lowerIndex + 1] <= targetDistance) {
                lowerIndex++;
            }
            
            const segmentStartDist = busData.offRouteDistances[lowerIndex];
            const segmentLength = busData.offRouteDistances[lowerIndex + 1] - segmentStartDist;
            let alpha = segmentLength > 0 ? (targetDistance - segmentStartDist) / segmentLength : 0;
            alpha = Math.max(0, Math.min(1, alpha));
            
            const a = busData.offRoutePath[lowerIndex];
            const b = busData.offRoutePath[lowerIndex + 1];
            busData.marker.setLatLng([a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha]);
        }
    });
    requestAnimationFrame(simulateTravel);
}

renderTransitStops();
fetchLiveBuses();
updateFetchInterval();
requestAnimationFrame(simulateTravel);