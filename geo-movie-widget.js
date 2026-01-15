
/**
 * GeoMovieWidget
 * A standalone class to render a synchronized map for property walkthrough videos.
 */
class GeoMovieWidget {
    /**
     * @param {Object} config
     * @param {string|HTMLElement} config.container - The container element (or selector) to render the map in.
     * @param {string|HTMLElement} config.videoElement - The video element (or selector) to synchronize with.
     * @param {string} config.projectUrl - URL to the project data JSON file.
     * @param {string} [config.assetBaseUrl] - Optional base URL for assets (images/videos). Defaults to projectUrl directory.
     * @param {string} [config.mapMode='scroll'] - 'scroll' for natural size with scrollbars, 'fit' to scale map to container.
     */
    constructor(config) {
        this.config = config;
        this.mapMode = config.mapMode || 'scroll'; // 'scroll' or 'fit'
        this.followMarker = config.followMarker !== false; // Default to true

        // --- Navigation State ---
        this.zoom = 1.0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.isPanning = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.container = typeof config.container === 'string'
            ? document.querySelector(config.container)
            : config.container;

        this.videoPlayer = typeof config.videoElement === 'string'
            ? document.querySelector(config.videoElement)
            : config.videoElement;

        if (!this.container || !this.videoPlayer) {
            console.error("GeoMovieWidget: Container or Video Element not found.");
            return;
        }

        // Determine base URL from projectUrl if not provided
        if (config.assetBaseUrl) {
            this.assetBaseUrl = config.assetBaseUrl;
        } else {
            // "path/to/data.json" -> "path/to/"
            const lastSlash = config.projectUrl.lastIndexOf('/');
            this.assetBaseUrl = lastSlash !== -1 ? config.projectUrl.substring(0, lastSlash + 1) : './';
        }

        // Support for explicit overrides per asset type
        this.videoUrlOverride = config.videoUrl || null;
        this.basemapUrlOverride = config.basemapUrl || null;

        // --- Internal State ---
        this.projectData = null;
        this.currentPathSegments = [];
        this.keyframes = [];
        this.backwardSegments = [];
        this.rotationSegments = [];

        this.currentMarkerAngle = 0;
        this.hoverPoint = null;
        this.isDragging = false;
        this.isVideoPausedForSeek = false;
        this.seekingRaf = null;

        // Constants/Settings
        this.COLORS = {
            STANDARD: 'rgb(5, 151, 49)',
            BACKWARD: 'rgb(43, 129, 213)',
            ROTATION: 'rgb(255, 165, 0)'
        };

        // Initialize UI
        this._setupDOM();
        this._setupEvents();

        console.log("GeoMovieWidget v3.1 - Interpolation Recovery");
        window.geoWidget = this; // Global access for debugging scale/state

        // Start Loading
        this.loadData();
    }

    _setupDOM() {
        // Ensure container has relative positioning for absolute children
        if (getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }
        this.container.style.overflow = 'auto'; // Allow scrolling if map is large

        // Create Wrapper (Coordinate system root)
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'geo-movie-wrapper';
        Object.assign(this.wrapper.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            overflow: 'hidden' // Important for pan/zoom
        });
        this.container.appendChild(this.wrapper);

        // Create the Transform Layer (The one we actually move/scale)
        this.transformLayer = document.createElement('div');
        this.transformLayer.className = 'geo-movie-transform-layer';
        Object.assign(this.transformLayer.style, {
            position: 'relative',
            transformOrigin: '0 0', // Crucial for zoom logic
            willChange: 'transform' // Performance hint
        });
        this.wrapper.appendChild(this.transformLayer);

        // 1. Basemap Image
        this.basemapImg = document.createElement('img');
        this.basemapImg.className = 'geo-movie-basemap';
        Object.assign(this.basemapImg.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            zIndex: '1',
            display: 'block',
            maxWidth: 'none', // Prevent external CSS constraints
            maxHeight: 'none'
        });
        this.transformLayer.appendChild(this.basemapImg);

        // 2. Geometry Canvas (Lines)
        this.geometryCanvas = document.createElement('canvas');
        this.geometryCanvas.className = 'geo-movie-geometry-layer';
        Object.assign(this.geometryCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            zIndex: '2',
            pointerEvents: 'none'
        });
        this.transformLayer.appendChild(this.geometryCanvas);
        this.geoCtx = this.geometryCanvas.getContext('2d');

        // 3. Marker Canvas (Marker + Interaction)
        this.markerCanvas = document.createElement('canvas');
        this.markerCanvas.className = 'geo-movie-marker-layer';
        Object.assign(this.markerCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            zIndex: '3',
            cursor: 'pointer',
            pointerEvents: 'auto'
        });
        this.transformLayer.appendChild(this.markerCanvas);
        this.markerCtx = this.markerCanvas.getContext('2d');

        // Layout styles are now unified and handled by transformLayer.
        // We'll calculate the initial zoom in loadData -> _parseProjectData -> resetView.
        this._updateTransform();

        // 4. Preview Tooltip (Created dynamically attached to body or container)
        this.previewTooltip = document.createElement('div');
        this.previewTooltip.className = 'geo-movie-tooltip';
        Object.assign(this.previewTooltip.style, {
            display: 'none',
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: '9999',
            border: '2px solid #FF5722',
            boxShadow: '0 0 15px rgba(255, 87, 34, 0.5)',
            background: '#000',
            width: '150px',
            height: '84px',
            borderRadius: '4px',
            overflow: 'hidden'
        });

        this.previewVideo = document.createElement('video');
        this.previewVideo.muted = true;
        this.previewVideo.playsInline = true;
        Object.assign(this.previewVideo.style, {
            width: '100%',
            height: '100%',
            objectFit: 'cover'
        });

        this.previewTime = document.createElement('div');
        Object.assign(this.previewTime.style, {
            position: 'absolute',
            bottom: '0',
            right: '0',
            background: 'rgba(0,0,0,0.7)',
            color: 'white',
            fontFamily: 'monospace',
            fontSize: '10px',
            padding: '2px 4px'
        });
        this.previewTime.textContent = '00:00';

        this.previewTooltip.appendChild(this.previewVideo);
        this.previewTooltip.appendChild(this.previewTime);
        document.body.appendChild(this.previewTooltip);

        // 5. UI Controls Overlay
        this._setupUI();
    }

    _setupUI() {
        const controls = document.createElement('div');
        controls.className = 'geo-movie-controls';
        Object.assign(controls.style, {
            position: 'absolute',
            bottom: '10px',
            right: '10px',
            zIndex: '10',
            display: 'flex',
            flexDirection: 'column',
            gap: '5px'
        });

        const btnStyle = {
            width: '32px',
            height: '32px',
            background: 'rgba(50, 50, 50, 0.8)',
            color: 'white',
            border: '1px solid #666',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none'
        };

        const createBtn = (text, title, onClick) => {
            const btn = document.createElement('div');
            btn.textContent = text;
            btn.title = title;
            Object.assign(btn.style, btnStyle);
            btn.onmouseover = () => btn.style.background = '#444';
            btn.onmouseout = () => btn.style.background = 'rgba(50, 50, 50, 0.8)';
            btn.onclick = onClick;
            return btn;
        };

        const btnZoomIn = createBtn('+', 'Przybliż', () => {
            this.zoom *= 1.2;
            this.followMarker = false;
            this._updateTransform();
        });
        const btnZoomOut = createBtn('-', 'Oddal', () => {
            this.zoom /= 1.2;
            this.followMarker = false;
            this._updateTransform();
        });
        const btnReset = createBtn('⟲', 'Resetuj widok', () => {
            this.resetView();
            this.followMarker = true;
        });

        controls.appendChild(btnZoomIn);
        controls.appendChild(btnZoomOut);
        controls.appendChild(btnReset);
        this.container.appendChild(controls);
    }

    _setupEvents() {
        if (this.videoPlayer) {
            // Bind methods to 'this' to avoid context loss
            this.boundUpdateMarker = () => this.updateMarker(this.videoPlayer.currentTime);

            this.videoPlayer.addEventListener('seeked', this.boundUpdateMarker);

            // Seeking loop for smoother drag
            this.videoPlayer.addEventListener('seeking', () => {
                this.isPlaybackEnded = false; // Reset on seek
                if (this.seekingRaf) return;
                this.seekingRaf = requestAnimationFrame(() => {
                    this.updateMarker(this.videoPlayer.currentTime);
                    this.seekingRaf = null;
                });
            });

            this.videoPlayer.addEventListener('play', () => {
                this.isPlaybackEnded = false;
            });

            this.videoPlayer.addEventListener('loadedmetadata', () => {
                // Re-build keyframes once duration is known
                if (this.projectData) this._parseProjectData();
            });

            this.videoPlayer.addEventListener('ended', () => {
                this.isPlaybackEnded = true;
                // Force a final draw and brute-force clear
                this.updateMarker(this.videoPlayer.currentTime);
                if (this.markerCtx) {
                    this.markerCtx.clearRect(0, 0, this.markerCanvas.width, this.markerCanvas.height);
                }
            });

            // Animation loop will be started after data is parsed
        }

        // Interaction Events on Marker Canvas
        this.markerCanvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.markerCanvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.markerCanvas.addEventListener('mouseleave', (e) => this._onMouseLeave(e));
        this.markerCanvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

        // Global mouseup to catch drags released outside canvas
        window.addEventListener('mouseup', () => this._onMouseUp());
        window.addEventListener('mousemove', (e) => this._onGlobalMouseMove(e));
    }

    _updateTransform() {
        this.transformLayer.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.zoom})`;
    }

    resetView() {
        if (!this.basemapImg.naturalWidth) return;
        const cw = this.container.clientWidth;
        const ch = this.container.clientHeight;

        if (this.currentPathSegments && this.currentPathSegments.length > 0) {
            // Focus on the START of the path
            const startPt = this.currentPathSegments[0].p1;

            // "Natural" zoom: let's try to show a reasonable area around the start
            const mw = this.basemapImg.naturalWidth;
            const mh = this.basemapImg.naturalHeight;
            const fitZoom = Math.min(cw / mw, ch / mh);

            // Zoom in more aggressively from the 'fit' view to see details.
            // Capping at 2.5 instead of 2.0 to allow closer inspection of large plans.
            this.zoom = Math.min(fitZoom * 5.0, 2.5);
            this.zoom = Math.max(this.zoom, fitZoom); // Ensure we don't zoom out more than fit

            this.offsetX = cw / 2 - startPt.x * this.zoom;
            this.offsetY = ch / 2 - startPt.y * this.zoom;
        } else {
            // Fallback to full basemap
            const mw = this.basemapImg.naturalWidth;
            const mh = this.basemapImg.naturalHeight;
            this.zoom = Math.min(cw / mw, ch / mh) * 0.95;
            this.offsetX = (cw - mw * this.zoom) / 2;
            this.offsetY = (ch - mh * this.zoom) / 2;
        }
        this._updateTransform();
    }

    _getPathExtent() {
        if (!this.currentPathSegments || this.currentPathSegments.length === 0) return null;
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;

        this.currentPathSegments.forEach(seg => {
            x1 = Math.min(x1, seg.p1.x, seg.p2.x);
            y1 = Math.min(y1, seg.p1.y, seg.p2.y);
            x2 = Math.max(x2, seg.p1.x, seg.p2.x);
            y2 = Math.max(y2, seg.p1.y, seg.p2.y);
        });

        // Add small buffer to avoid zero width/height
        if (x2 - x1 < 10) { x1 -= 50; x2 += 50; }
        if (y2 - y1 < 10) { y1 -= 50; y2 += 50; }

        return { x1, y1, x2, y2 };
    }

    _onWheel(e) {
        e.preventDefault();
        const delta = -e.deltaY;
        const factor = delta > 0 ? 1.1 : 0.9;
        const newZoom = Math.min(Math.max(this.zoom * factor, 0.05), 10);

        // Zoom towards mouse position
        const rect = this.wrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Current point under mouse in map coords
        const mapX = (mouseX - this.offsetX) / this.zoom;
        const mapY = (mouseY - this.offsetY) / this.zoom;

        this.zoom = newZoom;
        this.offsetX = mouseX - mapX * this.zoom;
        this.offsetY = mouseY - mapY * this.zoom;

        // Note: we DON'T disable followMarker on wheel zoom anymore per user request
        this._updateTransform();
    }

    _onGlobalMouseMove(e) {
        if (this.isPanning) {
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            // Disable followMarker ONLY if the video is paused/stopped.
            // If playing, we keep followMarker true so it resumes on release.
            if (this.videoPlayer.paused) {
                this.followMarker = false;
            }

            this.offsetX += dx;
            this.offsetY += dy;

            this._updateTransform();
        }
    }

    async loadData() {
        try {
            const finalUrl = this._getDirectLink(this.config.projectUrl);
            const response = await fetch(finalUrl);
            if (!response.ok) throw new Error("Failed to load JSON data");
            this.projectData = await response.json();
            this._parseProjectData();
        } catch (e) {
            console.error("GeoMovieWidget Error:", e);
        }
    }

    _parseProjectData() {
        if (!this.projectData || !this.projectData.project_data) return;

        // Assuming single map entry for now
        const mapEntry = this.projectData.project_data[0];
        const mapData = mapEntry[1].map_data;
        const moviesData = mapEntry[1].movies;

        // Load Basemap
        if (mapData.basemap) {
            let targetSrc = "";
            if (this.basemapUrlOverride) {
                targetSrc = this._getDirectLink(this.basemapUrlOverride);
            } else {
                const filename = mapData.basemap.split(/[\\/]/).pop();
                targetSrc = this.assetBaseUrl + filename;
            }
            this.basemapImg.src = targetSrc;
        }

        // Prepare Walker
        const movieIds = Object.keys(moviesData);
        if (movieIds.length > 0) {
            const movieId = movieIds[0];
            const movieInfo = moviesData[movieId];

            // Auto-set video source
            if (this.config.autoSetVideoSrc !== false) {
                let targetSrc = "";
                if (this.videoUrlOverride) {
                    targetSrc = this._getDirectLink(this.videoUrlOverride);
                } else {
                    const filename = movieInfo.path.split(/[\\/]/).pop();
                    targetSrc = this.assetBaseUrl + filename;
                }

                if (!this.videoPlayer.getAttribute('src') && !this.videoPlayer.src) {
                    this.videoPlayer.src = targetSrc;
                }
            }

            // Sync preview video source
            if (this.videoPlayer.src) {
                this.previewVideo.src = this.videoPlayer.src;
            } else {
                // If autoSetVideoSrc was false but we have targetSrc, use it for preview
                const movieInfo = moviesData[movieIds[0]];
                const filename = movieInfo.path.split(/[\\/]/).pop();
                const fallbackSrc = this.videoUrlOverride
                    ? this._getDirectLink(this.videoUrlOverride)
                    : this.assetBaseUrl + filename;
                this.previewVideo.src = fallbackSrc;
            }

            this._prepareWalker(mapData, movieInfo.connected_segment);
        }

        // Finalize after path segments are ready
        if (this.basemapImg.complete) {
            this._finalizeInitialization(mapData);
        } else {
            this.basemapImg.addEventListener('load', () => this._finalizeInitialization(mapData), { once: true });
        }
    }

    _finalizeInitialization(mapData) {
        const w = this.basemapImg.naturalWidth;
        const h = this.basemapImg.naturalHeight;
        this.transformLayer.style.width = w + 'px';
        this.transformLayer.style.height = h + 'px';
        this.geometryCanvas.width = w; this.geometryCanvas.height = h;
        this.markerCanvas.width = w; this.markerCanvas.height = h;

        this.resetView();
        this._drawGeometry(mapData);

        // Optional: Force a second reset after a short delay to catch late layout shifts
        setTimeout(() => this.resetView(), 100);

        if (this.videoPlayer && !this.isLoopStarted) {
            this.boundAnimate = this._animate.bind(this);
            requestAnimationFrame(this.boundAnimate);
            this.isLoopStarted = true;
        }
    }

    _drawGeometry(mapData) {
        const ctx = this.geoCtx;
        const w = this.geometryCanvas.width;
        const h = this.geometryCanvas.height;

        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const path = new Path2D();

        for (const key in mapData) {
            if (key === 'basemap') continue;
            const item = mapData[key];

            if (item.geometry) {
                item.geometry.forEach((s) => {
                    path.moveTo(s[0], s[1]);
                    path.lineTo(s[2], s[3]);
                });
            }
        }

        ctx.globalCompositeOperation = 'source-over';

        // 1. Glow
        ctx.setLineDash([]);
        ctx.shadowBlur = 30;
        ctx.shadowColor = 'rgba(43, 129, 213, 0.6)';
        ctx.strokeStyle = 'rgba(43, 129, 213, 0.05)';
        ctx.lineWidth = 20;
        ctx.stroke(path);

        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';

        // 2. Dashed Tube
        const DASH_PATTERN = [2, 3];
        ctx.setLineDash(DASH_PATTERN);
        ctx.strokeStyle = 'rgba(43, 129, 213, 0.6)';
        ctx.lineWidth = 3;
        ctx.stroke(path);

        // 3. Core
        ctx.strokeStyle = 'rgba(200, 220, 255, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke(path);

        ctx.setLineDash([]);
    }

    _prepareWalker(mapData, connectedSegmentId) {
        const segment = mapData[connectedSegmentId];
        if (!segment || !segment.geometry) return;

        // 1. Path Segments
        this.currentPathSegments = [];
        let totalLength = 0;

        segment.geometry.forEach(s => {
            const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
            this.currentPathSegments.push({
                p1: { x: s[0], y: s[1] },
                p2: { x: s[2], y: s[3] },
                length: len,
                startDist: totalLength,
                endDist: totalLength + len,
                angle: Math.atan2(s[3] - s[1], s[2] - s[0])
            });
            totalLength += len;
        });

        // 2. Backward Segments
        this.backwardSegments = [];
        if (segment.backward_segments) {
            segment.backward_segments.forEach(bs => {
                const segments = bs.geometry.map(g => ({ x1: g[0], y1: g[1], x2: g[2], y2: g[3] }));
                segments.forEach((seg, idx) => {
                    this.backwardSegments.push({
                        ...seg,
                        angle: Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1),
                        isStart: idx === 0,
                        isEnd: idx === segments.length - 1
                    });
                });
            });
        }

        // 3. Rotation Segments
        this.rotationSegments = [];
        if (segment.rotation_walking_segments) {
            segment.rotation_walking_segments.forEach(rs => {
                const rotVal = rs.rotation || 0;
                if (rs.geometry) {
                    const segments = rs.geometry.map(g => ({ x1: g[0], y1: g[1], x2: g[2], y2: g[3] }));
                    segments.forEach((seg, idx) => {
                        this.rotationSegments.push({
                            x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
                            value: rotVal,
                            angle: Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1),
                            isStart: idx === 0,
                            isEnd: idx === segments.length - 1
                        });
                    });
                }
            });
        }

        // 4. Build Timeline Keyframes (v3.0)
        this.keyframes = [];
        const totalPathDist = this.currentPathSegments.length > 0
            ? this.currentPathSegments[this.currentPathSegments.length - 1].endDist
            : 0;

        // Keyframe 0: Start of video -> Start of path
        this.keyframes.push({ time: 0, dist: 0 });

        if (segment.connected_points) {
            const points = segment.connected_points.slice().sort((a, b) => a.time_pos - b.time_pos);
            points.forEach(p => {
                const px = p.geometry[0];
                const py = p.geometry[1];
                let distOnPath = -1;

                // Find which segment this point belongs to
                for (const seg of this.currentPathSegments) {
                    const d = this._distToSegment({ x: px, y: py }, seg.p1, seg.p2);
                    if (d < 5.0) { // Be lenient with point-to-line matching
                        distOnPath = this._getDistOnPath({ x: px, y: py }, seg);
                        break;
                    }
                }

                if (distOnPath !== -1) {
                    this.keyframes.push({
                        time: p.time_pos / 1000,
                        dist: distOnPath,
                        view_range: p.view_range || [0, 0]
                    });
                }
            });
        }

        // Keyframe End: End of video -> End of path
        const duration = this.videoPlayer.duration || 0;
        if (duration > 0) {
            this.keyframes.push({ time: duration, dist: totalPathDist });
        }

        // Sort by time and filter out duplicates
        this.keyframes.sort((a, b) => a.time - b.time);

        // Ensure no redundant points at the same time
        this.keyframes = this.keyframes.filter((k, i, arr) => i === 0 || k.time > arr[i - 1].time + 0.001);

        // Final fallback if only one point
        if (this.keyframes.length === 1 && duration > 0) {
            this.keyframes.push({ time: duration, dist: totalPathDist });
        }

        if (this.currentPathSegments.length > 0) {
            this.currentMarkerAngle = this.currentPathSegments[0].angle;
        }
    }

    _animate() {
        this.updateMarker(this.videoPlayer.currentTime);
        requestAnimationFrame(this.boundAnimate);
    }

    updateMarker(time) {
        if (!this.keyframes || this.keyframes.length === 0) return;

        const lastSeg = this.currentPathSegments[this.currentPathSegments.length - 1];
        const totalPathDist = lastSeg ? lastSeg.endDist : 0;

        // Find surrounding keyframes
        let k1 = this.keyframes[0];
        let k2 = this.keyframes[this.keyframes.length - 1];

        let currentDist = k1.dist;

        if (this.keyframes.length >= 2) {
            if (time <= k1.time) {
                k2 = k1;
                currentDist = k1.dist;
            } else if (time >= k2.time) {
                k1 = k2;
                currentDist = k2.dist;
            } else {
                for (let i = 0; i < this.keyframes.length - 1; i++) {
                    if (time >= this.keyframes[i].time && time <= this.keyframes[i + 1].time) {
                        k1 = this.keyframes[i];
                        k2 = this.keyframes[i + 1];
                        break;
                    }
                }
                // Linear interpolation of distance
                if (k1 !== k2 && (k2.time - k1.time) > 0.001) {
                    const tRatio = (time - k1.time) / (k2.time - k1.time);
                    currentDist = k1.dist + (k2.dist - k1.dist) * tRatio;
                }
            }
        }

        // Safety clamp
        currentDist = Math.max(0, Math.min(totalPathDist, currentDist));

        const seg = this.currentPathSegments.find(s => currentDist >= s.startDist && currentDist <= s.endDist) || lastSeg;

        if (seg) {
            const distOnSeg = currentDist - seg.startDist;
            const segLen = seg.length > 0.001 ? seg.length : 1;
            const ratio = Math.max(0, Math.min(1, distOnSeg / segLen));

            const x = seg.p1.x + (seg.p2.x - seg.p1.x) * ratio;
            const y = seg.p1.y + (seg.p2.y - seg.p1.y) * ratio;

            let targetAngle = seg.angle;

            // Spatial Detection
            const pt = { x, y };
            const detectionBuffer = 0.5;
            const endpointBuffer = 4.0;

            let touchBackward = false;
            let activeBackwardSeg = null;

            for (const bs of this.backwardSegments) {
                if (this._areAnglesAligned(bs.angle, seg.angle)) {
                    if (this._distToSegment(pt, { x: bs.x1, y: bs.y1 }, { x: bs.x2, y: bs.y2 }) < detectionBuffer) {
                        touchBackward = true;
                        activeBackwardSeg = bs;
                        break;
                    }
                }
            }

            let canRotate = true;
            if (touchBackward && activeBackwardSeg) {
                if (activeBackwardSeg.isEnd && Math.hypot(pt.x - activeBackwardSeg.x2, pt.y - activeBackwardSeg.y2) < endpointBuffer) canRotate = false;
                if (activeBackwardSeg.isStart && canRotate && Math.hypot(pt.x - activeBackwardSeg.x1, pt.y - activeBackwardSeg.y1) < endpointBuffer) canRotate = false;
            }

            let activeRotationSegs = [];
            if (canRotate) {
                for (const rs of this.rotationSegments) {
                    if (this._areAnglesAligned(rs.angle, seg.angle) && this._distToSegment(pt, { x: rs.x1, y: rs.y1 }, { x: rs.x2, y: rs.y2 }) < detectionBuffer) {
                        activeRotationSegs.push(rs);
                    }
                }
                for (const rs of activeRotationSegs) {
                    if ((rs.isEnd && Math.hypot(pt.x - rs.x2, pt.y - rs.y2) < endpointBuffer) ||
                        (rs.isStart && Math.hypot(pt.x - rs.x1, pt.y - rs.x1) < endpointBuffer)) { canRotate = false; break; }
                }
            }

            if (canRotate) {
                if (touchBackward) targetAngle += Math.PI;
                for (const rs of activeRotationSegs) {
                    let rotationOffset = (rs.value || 0) * Math.PI / 180;
                    if (touchBackward) rotationOffset = -rotationOffset;
                    targetAngle += rotationOffset;
                }

                // Rotation wiggle (v3.1)
                const vr = k1.view_range || [0, 0];
                if (vr[0] !== 0 || vr[1] !== 0) {
                    const dur = k2.time - k1.time;
                    if (dur > 0.1) {
                        const progress = (time - k1.time) / dur;
                        const cycle = Math.sin(progress * Math.PI * 2);
                        const limit = Math.max(Math.abs(vr[0]), Math.abs(vr[1]));
                        targetAngle += cycle * limit * Math.PI / 180;
                    }
                }

                targetAngle = this._normalizeAngle(targetAngle);
                this.currentMarkerAngle = this._normalizeAngle(this.currentMarkerAngle);
                let delta = targetAngle - this.currentMarkerAngle;
                if (delta > Math.PI) delta -= 2 * Math.PI;
                if (delta < -Math.PI) delta += 2 * Math.PI;
                this.currentMarkerAngle += delta / 20.0;
            }

            this._drawMarker(x, y, this.currentMarkerAngle);

            if ((!this.videoPlayer.paused || this.followMarker) && !this.isPanning) {
                this._centerOnMarker(x, y);
            }
        }
    }

    _drawMarker(x, y, angleRad) {
        const ctx = this.markerCtx;
        ctx.clearRect(0, 0, this.markerCanvas.width, this.markerCanvas.height);
        // FOOLPROOF END-OF-VIDEO DETECTION

        // 1. Browser property
        const isEndedFlag = this.videoPlayer.ended;
        // 2. Our custom flag from event listener
        const isEndedInternal = this.isPlaybackEnded;
        // 3. Time comparison (is current time at the very end of wideo?)
        // Patient 0.05s buffer - stay visible as long as possible
        const isAtDurationEnd = this.videoPlayer.duration > 0 &&
            this.videoPlayer.currentTime >= (this.videoPlayer.duration - 0.05);

        // Combined "Hiding" condition: only hide if video is truly finished
        const isEnded = isEndedFlag || isEndedInternal || isAtDurationEnd;

        // Debug log once when it hits end condition
        if (isEnded && !this._lastWasEnded) {
            console.log(`Video Final State: Ended, Time: ${this.videoPlayer.currentTime.toFixed(3)}, Duration: ${this.videoPlayer.duration.toFixed(3)}`);
        }
        this._lastWasEnded = isEnded;

        // Hide main marker if video ended
        if (!isEnded) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(angleRad);

            const scale = 0.5;
            ctx.scale(scale, scale);

            const range = Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, 100, -range, range);
            ctx.closePath();

            const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 100);
            grad.addColorStop(0, 'rgba(255, 87, 34, 0.5)');
            grad.addColorStop(1, 'rgba(255, 87, 34, 0)');
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(0, 0, 10, 0, Math.PI * 2);
            ctx.fillStyle = '#FF5722';
            ctx.fill();

            ctx.restore();
        }

        // Hover Ghost - Hide if ended to avoid confusion with the main marker
        if (this.hoverPoint && !isEnded) {
            ctx.save();
            ctx.translate(this.hoverPoint.x, this.hoverPoint.y);
            if (this.hoverPoint.angle !== undefined) ctx.rotate(this.hoverPoint.angle);

            ctx.beginPath();
            ctx.moveTo(10, 0);
            ctx.lineTo(-6, 6);
            ctx.lineTo(-6, -6);
            ctx.closePath();

            ctx.fillStyle = '#FF5722';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
            ctx.shadowBlur = 4;
            ctx.fill();

            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.restore();
        }
    }

    _centerOnMarker(x, y) {
        // Center the transformLayer offset so that (x,y) is in the middle of container
        const cw = this.container.clientWidth;
        const ch = this.container.clientHeight;

        // Target offset to center (x,y) at zoom level
        this.offsetX = cw / 2 - x * this.zoom;
        this.offsetY = ch / 2 - y * this.zoom;

        this._updateTransform();
    }

    // --- Interaction ---
    _onMouseDown(e) {
        e.preventDefault();
        const coords = this._getMapCoords(e);
        const x = coords.x;
        const y = coords.y;

        const distOnPath = this._getClosestDistOnPath({ x, y });
        if (distOnPath !== -1) {
            this.isDragging = true;
            if (!this.videoPlayer.paused) {
                this.videoPlayer.pause();
                this.isVideoPausedForSeek = true;
            }
            this._handleInteraction(e);
        } else {
            // Start Panning
            this.isPanning = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        }
    }

    _onMouseUp() {
        this.isPanning = false;
        if (this.isDragging) {
            this.isDragging = false;
            if (this.isVideoPausedForSeek) {
                this.videoPlayer.play();
                this.isVideoPausedForSeek = false;
            }
        }
    }

    _getMapCoords(e) {
        const rect = this.wrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        return {
            x: (mouseX - this.offsetX) / this.zoom,
            y: (mouseY - this.offsetY) / this.zoom
        };
    }

    _onMouseMove(e) {
        this._handleInteraction(e);
        if (this.videoPlayer.paused) {
            requestAnimationFrame(() => this.updateMarker(this.videoPlayer.currentTime));
        }
    }

    _onMouseLeave(e) {
        this.hoverPoint = null;
        if (this.videoPlayer.paused) {
            requestAnimationFrame(() => this.updateMarker(this.videoPlayer.currentTime));
        }
    }

    _handleInteraction(e) {
        const coords = this._getMapCoords(e);
        const clickX = coords.x;
        const clickY = coords.y;

        const distOnPath = this._getClosestDistOnPath({ x: clickX, y: clickY });

        if (distOnPath !== -1) {
            const pt = this._getPointFromDistance(distOnPath);
            if (pt) {
                this.hoverPoint = pt;
                this.markerCanvas.style.cursor = 'pointer';
                this._showPreview(e, distOnPath);
            } else {
                this._hideHover();
            }

            if (this.isDragging) {
                const time = this._getTimeFromDistance(distOnPath);
                if (time !== -1) {
                    this.videoPlayer.currentTime = time;
                    this.updateMarker(time);
                }
            }
        } else {
            this._hideHover();
        }
    }

    _hideHover() {
        this.hoverPoint = null;
        this.markerCanvas.style.cursor = 'default';
        this.previewTooltip.style.display = 'none';
    }

    _showPreview(e, distOnPath) {
        // Ensure preview source matches
        if (!this.previewVideo.src && this.videoPlayer.currentSrc) {
            this.previewVideo.src = this.videoPlayer.currentSrc;
        }

        const time = this._getTimeFromDistance(distOnPath);
        if (time !== -1) {
            if (Math.abs(this.previewVideo.currentTime - time) > 0.1) {
                this.previewVideo.currentTime = time;
            }

            const mins = Math.floor(time / 60);
            const secs = Math.floor(time % 60);
            this.previewTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

            this.previewTooltip.style.left = (e.clientX + 20) + 'px';
            this.previewTooltip.style.top = (e.clientY - 100) + 'px';
            this.previewTooltip.style.display = 'block';
        }
    }

    // --- Helpers ---
    _getDistOnPath(pt, seg) {
        const vx = seg.p2.x - seg.p1.x;
        const vy = seg.p2.y - seg.p1.y;
        const wx = pt.x - seg.p1.x;
        const wy = pt.y - seg.p1.y;
        const len2 = vx * vx + vy * vy;
        if (len2 === 0) return seg.startDist;

        let t = (wx * vx + wy * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        return seg.startDist + t * Math.sqrt(len2);
    }

    _distToSegment(p, v, w) {
        const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
        if (l2 == 0) return Math.hypot(p.x - v.x, p.y - v.y);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
    }

    _areAnglesAligned(a1, a2) {
        let diff = Math.abs(a1 - a2) % Math.PI;
        if (diff > Math.PI / 2) diff = Math.PI - diff;
        return diff < 0.5;
    }

    _normalizeAngle(a) {
        a = a % (2 * Math.PI);
        if (a < 0) a += 2 * Math.PI;
        return a;
    }

    _getClosestDistOnPath(pt) {
        let bestDist = -1;
        let minDist = Infinity;

        for (const seg of this.currentPathSegments) {
            const vx = seg.p2.x - seg.p1.x;
            const vy = seg.p2.y - seg.p1.y;
            const wx = pt.x - seg.p1.x;
            const wy = pt.y - seg.p1.y;
            const len2 = vx * vx + vy * vy;
            let t = 0;
            if (len2 > 0) t = (wx * vx + wy * vy) / len2;
            t = Math.max(0, Math.min(1, t));

            const projX = seg.p1.x + t * vx;
            const projY = seg.p1.y + t * vy;
            const d = Math.hypot(pt.x - projX, pt.y - projY);

            if (d < minDist) {
                minDist = d;
                bestDist = seg.startDist + t * Math.sqrt(len2);
            }
        }
        if (minDist > 50) return -1;
        return bestDist;
    }

    _getPointFromDistance(dist) {
        if (this.currentPathSegments.length === 0) return null;

        // Clamp distance to path bounds to prevent "outside" markers
        const lastSeg = this.currentPathSegments[this.currentPathSegments.length - 1];
        const effectiveDist = Math.max(0, Math.min(dist, lastSeg.endDist));

        const seg = this.currentPathSegments.find(s => effectiveDist >= s.startDist && effectiveDist <= s.endDist) || lastSeg;
        if (!seg) return null;

        const distOnSeg = effectiveDist - seg.startDist;
        const segLen = seg.length > 0.001 ? seg.length : 1;

        // Clamp ratio to [0, 1]
        const ratio = Math.max(0, Math.min(1, distOnSeg / segLen));

        return {
            x: seg.p1.x + (seg.p2.x - seg.p1.x) * ratio,
            y: seg.p1.y + (seg.p2.y - seg.p1.y) * ratio,
            angle: seg.angle
        };
    }

    _getTimeFromDistance(dist) {
        if (!this.keyframes || this.keyframes.length < 2) return -1;

        const lastSeg = this.currentPathSegments[this.currentPathSegments.length - 1];
        const totalD = lastSeg ? lastSeg.endDist : 0;
        const effectiveDist = Math.max(0, Math.min(dist, totalD));

        // Find surrounding keyframes by distance
        let k1 = this.keyframes[0];
        let k2 = this.keyframes[this.keyframes.length - 1];

        for (let i = 0; i < this.keyframes.length - 1; i++) {
            const d1 = this.keyframes[i].dist;
            const d2 = this.keyframes[i + 1].dist;
            const minD = Math.min(d1, d2);
            const maxD = Math.max(d1, d2);

            if (effectiveDist >= (minD - 0.1) && effectiveDist <= (maxD + 0.1)) {
                k1 = this.keyframes[i];
                k2 = this.keyframes[i + 1];
                break;
            }
        }

        if (k1 === k2) return k1.time;

        const dDiff = k2.dist - k1.dist;
        if (Math.abs(dDiff) < 0.001) return k1.time;

        const tRatio = (effectiveDist - k1.dist) / dDiff;
        const time = k1.time + (k2.time - k1.time) * tRatio;
        return Math.max(0, Math.min(this.videoPlayer.duration || 9999, time));
    }

    /**
     * Helper to convert Google Drive share links to direct download links.
     */
    _getDirectLink(url) {
        if (!url) return "";
        const gdMatch = url.match(/[-\w]{25,}/);
        if (url.includes('drive.google.com') && gdMatch) {
            return `https://drive.google.com/uc?export=download&id=${gdMatch[0]}`;
        }
        return url;
    }
}
