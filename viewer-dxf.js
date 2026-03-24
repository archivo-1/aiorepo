(function() {
    'use strict';

    // ── Objetos Globales ──────────────────────────────────────────────────
    let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
    let cameraMode = 'orbit';
    let is2DModel = false;
    let modelGroup = null;
    let groundMeshes = [];
    let modelSize = new THREE.Vector3();
    let modelCenter = new THREE.Vector3();
    let modelSpan = 10;
    let layerMeshes = {};
    const keys = {};
    const velocity = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const downVec = new THREE.Vector3(0, -1, 0);
    const WALK_HEIGHT = 1.7;

    // ── 0. Helper para texto en sprite ─────────────────────────────────────

    function makeTextSprite(message, parameters = {}) {
        const fontface = parameters.fontface || 'Arial';
        const fontsize = parameters.fontsize || 14;
        const textColor = parameters.textColor || '#ffffff';
        const backgroundColor = parameters.backgroundColor || 'rgba(0,0,0,0.0)';

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        context.font = fontsize + 'px ' + fontface;
        const metrics = context.measureText(message);
        const textWidth = metrics.width;

        // algo de padding
        const padding = 6;
        canvas.width = textWidth + padding * 2;
        canvas.height = fontsize + padding * 2;

        // volver a setear la fuente después de cambiar width/height
        context.font = fontsize + 'px ' + fontface;
        context.fillStyle = backgroundColor;
        context.fillRect(0, 0, canvas.width, canvas.height);

        context.fillStyle = textColor;
        context.textBaseline = 'top';
        context.fillText(message, padding, padding);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false });
        const sprite = new THREE.Sprite(material);

        // escalar a unidades del modelo de forma aproximada
        const scaleFactor = 1; // ajusta esto según escala de tu plano
        sprite.scale.set(canvas.width * scaleFactor, canvas.height * scaleFactor, 1);

        return sprite;
    }

    // ── 1. HELPERS Y UI ─────────────────────────────────────────────────────

    function getModelIdFromQuery() {
        const p = new URLSearchParams(window.location.search);
        return p.get('id') || p.get('file');
    }

    function showLoading(msg) {
        const el = document.getElementById('loading');
        if (el) {
            el.classList.remove('hidden');
            const p = el.querySelector('p');
            if (p) p.textContent = msg;
        }
    }

    function hideLoading() {
        const el = document.getElementById('loading');
        if (el) el.classList.add('hidden');
    }

    // ── 2. LÓGICA DE DETECCIÓN Y CONFIGURACIÓN ──────────────────────────────

    function detectIs3D(entities) {
        for (const entity of entities) {
            if (entity.position && Math.abs(entity.position.z) > 0.01) return true;
            if (entity.vertices) {
                for (const v of entity.vertices) {
                    if (Math.abs(v.z) > 0.01) return true;
                }
            }
            if (entity.elevation && Math.abs(entity.elevation) > 0.01) return true;
        }
        return false;
    }

    function applyConfiguration(config, isActually3D) {
        const force2D = !isActually3D || (config.cameraModes && config.cameraModes.length === 0);

        if (force2D) {
            console.log('Modo 2D detectado o forzado. Bloqueando a Top View.');
            setCameraMode('ortho');
            document.querySelectorAll('.cam-btn').forEach(btn => {
                if (btn.dataset.mode !== 'ortho') btn.style.display = 'none';
            });
        } else {
            document.querySelectorAll('.cam-btn').forEach(btn => {
                const mode = btn.dataset.mode;
                btn.style.display = config.cameraModes.includes(mode) ? 'inline-block' : 'none';
            });
        }

        const layersPanel = document.getElementById('layers-panel');
        if (layersPanel) layersPanel.style.display = config.showLayers ? 'block' : 'none';
    }

    // ── 3. CARGA Y PROCESAMIENTO ────────────────────────────────────────────

    async function loadModel() {
        const modelId = getModelIdFromQuery();
        showLoading('Consultando content.json...');

        try {
            const resConfig = await fetch('content.json');
            const allModels = await resConfig.json();
            const modelData = allModels.find(m => m.id === modelId || m.archivo === modelId);

            if (!modelData) throw new Error(`ID ${modelId} no encontrado en el JSON`);

            showLoading(`Descargando ${modelData.archivo}...`);
            const response = await fetch(`models/${modelData.archivo}`);
            if (!response.ok) throw new Error('No se pudo descargar el archivo .dxf');
            const text = await response.text();

            showLoading('Parseando DXF...');
            const parser = new window.DxfParser();
            const dxf = parser.parseSync(text);
            console.log('Entidades DXF:', dxf.entities.map(e => e.type));

            is2DModel = !detectIs3D(dxf.entities);

            modelGroup = buildDXFGeometries(dxf);
            modelGroup.rotation.x = -Math.PI / 2;
            scene.add(modelGroup);

            processLayers(modelGroup);

            const box = new THREE.Box3().setFromObject(modelGroup);
            box.getCenter(modelCenter);
            box.getSize(modelSize);
            modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

            applyConfiguration(modelData.uiConfig, !is2DModel);
            resetCamera();
            updateLayersUI();

            hideLoading();

        } catch (error) {
            console.error(error);
            showLoading(`Error: ${error.message}`);
        }
    }

    function buildDXFGeometries(data) {
        const group = new THREE.Group();

        data.entities.forEach(entity => {
            const layerName = entity.layer || 'Default';
            let color = entity.color !== undefined ? entity.color : 0xffffff;
            if (typeof color === 'object') color = (color.r << 16) | (color.g << 8) | color.b;

            const mat = new THREE.LineBasicMaterial({ color: color });
            let mesh = null;

            // LINE
            if (entity.type === 'LINE') {
                if (!entity.vertices || entity.vertices.length < 2) return;
                const geo = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(entity.vertices[0].x, entity.vertices[0].y, entity.vertices[0].z || 0),
                    new THREE.Vector3(entity.vertices[1].x, entity.vertices[1].y, entity.vertices[1].z || 0)
                ]);
                mesh = new THREE.Line(geo, mat);
            }
            // POLYLINES
            else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
                if (!entity.vertices || entity.vertices.length === 0) return;
                const points = entity.vertices.map(v => new THREE.Vector3(v.x, v.y, v.z || 0));
                if (entity.shape || entity.closed) points.push(points[0]);
                const geo = new THREE.BufferGeometry().setFromPoints(points);
                mesh = new THREE.Line(geo, mat);
            }
            // CIRCLE
            else if (entity.type === 'CIRCLE') {
                const curve = new THREE.EllipseCurve(
                    entity.center.x,
                    entity.center.y,
                    entity.radius,
                    entity.radius,
                    0,
                    Math.PI * 2,
                    false,
                    0
                );
                const points = curve.getPoints(64).map(p => new THREE.Vector3(p.x, p.y, entity.center.z || 0));
                const geo = new THREE.BufferGeometry().setFromPoints(points);
                mesh = new THREE.Line(geo, mat);
            }
            // ARC
            else if (entity.type === 'ARC') {
                const center = entity.center;
                const radius = entity.radius;
                const start = entity.startAngle || 0;
                const end = entity.endAngle || Math.PI * 2;

                const curve = new THREE.ArcCurve(
                    center.x,
                    center.y,
                    radius,
                    start,
                    end,
                    false
                );
                const points = curve.getPoints(32).map(p => new THREE.Vector3(p.x, p.y, center.z || 0));
                const geo = new THREE.BufferGeometry().setFromPoints(points);
                mesh = new THREE.Line(geo, mat);
            }
            // HATCH (contorno simple mejorado)
            else if (entity.type === 'HATCH') {
                if (!entity.loops) return;
                entity.loops.forEach(loop => {
                    const loopPoints = [];

                    if (loop.entities && Array.isArray(loop.entities)) {
                        loop.entities.forEach(e => {
                            if (e.type === 'LINE' && e.vertices && e.vertices.length >= 2) {
                                const v1 = e.vertices[0];
                                const v2 = e.vertices[1];
                                loopPoints.push(
                                    new THREE.Vector3(v1.x, v1.y, v1.z || 0),
                                    new THREE.Vector3(v2.x, v2.y, v2.z || 0)
                                );
                            } else if (e.type === 'ARC') {
                                const c = e.center;
                                const r = e.radius;
                                const start = e.startAngle || 0;
                                const end = e.endAngle || Math.PI * 2;
                                const arcCurve = new THREE.ArcCurve(
                                    c.x,
                                    c.y,
                                    r,
                                    start,
                                    end,
                                    false
                                );
                                const pts = arcCurve.getPoints(16).map(p => new THREE.Vector3(p.x, p.y, c.z || 0));
                                loopPoints.push(...pts);
                            }
                        });
                    }

                    if (loopPoints.length > 1) {
                        const first = loopPoints[0];
                        const last = loopPoints[loopPoints.length - 1];
                        if (!first.equals(last)) loopPoints.push(first.clone());

                        const geo = new THREE.BufferGeometry().setFromPoints(loopPoints);
                        const hatchLine = new THREE.Line(geo, mat);
                        hatchLine.userData.layer = layerName;
                        group.add(hatchLine);
                    }
                });
            }
            // DIMENSION (básico: usa bloque de geometría o línea simple)
            else if (entity.type === 'DIMENSION') {
                console.log('DIMENSION entity:', entity);

                const dimMat = mat;

                if (entity.block && Array.isArray(entity.block.entities)) {
                    entity.block.entities.forEach(sub => {
                        if (sub.type === 'LINE' && sub.vertices && sub.vertices.length >= 2) {
                            const v1 = sub.vertices[0];
                            const v2 = sub.vertices[1];
                            const geo = new THREE.BufferGeometry().setFromPoints([
                                new THREE.Vector3(v1.x, v1.y, v1.z || 0),
                                new THREE.Vector3(v2.x, v2.y, v2.z || 0)
                            ]);
                            const line = new THREE.Line(geo, dimMat);
                            line.userData.layer = layerName;
                            group.add(line);
                        }
                        if (sub.type === 'ARC') {
                            const c = sub.center;
                            const r = sub.radius;
                            const start = sub.startAngle || 0;
                            const end = sub.endAngle || Math.PI * 2;
                            const curve = new THREE.ArcCurve(
                                c.x,
                                c.y,
                                r,
                                start,
                                end,
                                false
                            );
                            const pts = curve.getPoints(16).map(p => new THREE.Vector3(p.x, p.y, c.z || 0));
                            const geo = new THREE.BufferGeometry().setFromPoints(pts);
                            const arc = new THREE.Line(geo, dimMat);
                            arc.userData.layer = layerName;
                            group.add(arc);
                        }
                    });
                } else {
                    const p1 = entity.firstPoint || entity.definitionPoint || entity.defPoint2;
                    const p2 = entity.secondPoint || entity.defPoint3;
                    if (p1 && p2) {
                        const geo = new THREE.BufferGeometry().setFromPoints([
                            new THREE.Vector3(p1.x, p1.y, p1.z || 0),
                            new THREE.Vector3(p2.x, p2.y, p2.z || 0)
                        ]);
                        const line = new THREE.Line(geo, dimMat);
                        line.userData.layer = layerName;
                        group.add(line);
                    } else {
                        console.warn('DIMENSION sin puntos claros:', entity);
                    }
                }

                // Texto de la cota (si viene plain text)
                const dimText = entity.text || entity.actualMeasurement?.toString?.();
                const textPos = entity.textMidPoint || entity.middleOfText || entity.textPosition;
                if (dimText && textPos) {
                    const sprite = makeTextSprite(dimText.toString(), {
                        fontsize: 14,
                        textColor: '#ffffff',
                        backgroundColor: 'rgba(0,0,0,0.0)'
                    });
                    sprite.position.set(textPos.x, textPos.y, (textPos.z || 0));
                    sprite.userData.layer = layerName;
                    group.add(sprite);
                }
            }
            // MTEXT (texto general)
            else if (entity.type === 'MTEXT') {
                // dxf-parser suele exponer 'text' o similar, y 'position'
                const rawText = entity.text || entity.textValue || '';
                if (!rawText) return;
                const pos = entity.position || entity.insertPoint;
                if (!pos) return;

                // MTEXT trae códigos de formato (\P, \A, etc.) que ignoramos por ahora.[web:28][web:29][web:30]
                const plain = rawText
                    .replace(/\\P/g, '\n')
                    .replace(/\\[A-Za-z].*?;/g, '')
                    .trim();

                if (!plain) return;

                const sprite = makeTextSprite(plain, {
                    fontsize: 14,
                    textColor: '#ffffff',
                    backgroundColor: 'rgba(0,0,0,0.0)'
                });
                sprite.position.set(pos.x, pos.y, (pos.z || 0));
                sprite.userData.layer = layerName;
                group.add(sprite);
            }

            if (mesh) {
                mesh.userData.layer = layerName;
                group.add(mesh);
            }
        });

        return group;
    }

    function processLayers(group) {
        layerMeshes = {};
        groundMeshes = [];
        group.traverse(child => {
            if (child.userData && child.userData.layer) {
                const ln = child.userData.layer;
                if (!layerMeshes[ln]) layerMeshes[ln] = [];
                layerMeshes[ln].push(child);
            }
            if (child.isLine || child.isMesh || child.isSprite) groundMeshes.push(child);
        });
    }

    // ── 4. CÁMARAS Y ANIMACIÓN ──────────────────────────────────────────────

    function setCameraMode(mode) {
        cameraMode = mode;
        if (mode === 'orbit') {
            activeCamera = orbitCamera;
            orbitControls.object = activeCamera;
            orbitControls.enabled = true;
            orbitControls.enableRotate = true;
        } else if (mode === 'ortho') {
            activeCamera = orthoCamera;
            orbitControls.object = orthoCamera;
            orbitControls.enabled = true;
            orbitControls.enableRotate = false;
            syncOrthoCamera();
        }
        updateModeUI();
    }

    function syncOrthoCamera() {
        if (!orthoCamera) return;
        const aspect = window.innerWidth / window.innerHeight;
        const halfH = modelSpan * 0.8;
        const halfW = halfH * aspect;
        orthoCamera.left = -halfW;
        orthoCamera.right = halfW;
        orthoCamera.top = halfH;
        orthoCamera.bottom = -halfH;
        orthoCamera.position.set(modelCenter.x, modelCenter.y + modelSpan * 2, modelCenter.z);
        orthoCamera.lookAt(modelCenter);
        orthoCamera.updateProjectionMatrix();
    }

    function resetCamera() {
        if (!modelGroup) return;
        const d = modelSpan;
        orbitCamera.position.set(modelCenter.x, modelCenter.y + d, modelCenter.z + d);
        orbitControls.target.copy(modelCenter);
        orbitControls.update();
        if (cameraMode === 'ortho') syncOrthoCamera();
    }

    function updateModeUI() {
        document.querySelectorAll('.cam-btn[data-mode]').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === cameraMode);
        });
    }

    function updateLayersUI() {
        const list = document.getElementById('layers-list');
        if (!list) return;
        list.innerHTML = '';
        Object.keys(layerMeshes).sort().forEach(name => {
            const row = document.createElement('div');
            row.className = 'layer-row';
            row.innerHTML = `<span>${name}</span><input type="checkbox" checked>`;
            row.querySelector('input').onchange = (e) => {
                layerMeshes[name].forEach(m => m.visible = e.target.checked);
            };
            list.appendChild(row);
        });
    }

    // ── 5. INICIALIZACIÓN ───────────────────────────────────────────────────

    function init() {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050608);
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        const aspect = window.innerWidth / window.innerHeight;
        orbitCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000000);
        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);
        activeCamera = orbitCamera;

        orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
        orbitControls.enableDamping = true;

        scene.add(new THREE.AmbientLight(0xffffff, 1.2));

        window.addEventListener('resize', () => {
            renderer.setSize(window.innerWidth, window.innerHeight);
            orbitCamera.aspect = window.innerWidth / window.innerHeight;
            orbitCamera.updateProjectionMatrix();
            syncOrthoCamera();
        });

        document.querySelectorAll('.cam-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => setCameraMode(btn.dataset.mode));
        });

        loadModel();

        function animate() {
            requestAnimationFrame(animate);
            orbitControls.update();
            renderer.render(scene, activeCamera);
        }
        animate();
    }

    init();
})();
