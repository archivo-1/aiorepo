(function() {
    'use strict';

    // ── Objetos Globales ──────────────────────────────────────────────────
    let scene, renderer, orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
    let cameraMode = 'orbit'; 
    let is2DModel = false; // Flag para bloquear navegación si el plano es plano
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

    // Analiza si alguna entidad tiene coordenadas en Z significativas
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

    // Filtra la interfaz según el JSON y si el modelo es 2D
    function applyConfiguration(config, isActually3D) {
        // Si no es 3D o el JSON viene vacío de modos, forzamos 2D
        const force2D = !isActually3D || (config.cameraModes && config.cameraModes.length === 0);

        if (force2D) {
            console.log("Modo 2D detectado o forzado. Bloqueando a Top View.");
            setCameraMode('ortho');
            // Ocultamos botones que no sean Ortho/Top
            document.querySelectorAll('.cam-btn').forEach(btn => {
                if (btn.dataset.mode !== 'ortho') btn.style.display = 'none';
            });
        } else {
            // Mostramos solo los botones permitidos en el JSON
            document.querySelectorAll('.cam-btn').forEach(btn => {
                const mode = btn.dataset.mode;
                btn.style.display = config.cameraModes.includes(mode) ? 'inline-block' : 'none';
            });
        }

        // Panel de capas
        const layersPanel = document.getElementById('layers-panel');
        if (layersPanel) layersPanel.style.display = config.showLayers ? 'block' : 'none';
    }

    // ── 3. CARGA Y PROCESAMIENTO ────────────────────────────────────────────

    async function loadModel() {
        const modelId = getModelIdFromQuery();
        showLoading('Consultando content.json...');

        try {
            // A. Buscar en el JSON
            const resConfig = await fetch('content.json');
            const allModels = await resConfig.json();
            const modelData = allModels.find(m => m.id === modelId || m.archivo === modelId);

            if (!modelData) throw new Error(`ID ${modelId} no encontrado en el JSON`);

            // B. Descargar archivo DXF
            showLoading(`Descargando ${modelData.archivo}...`);
            const response = await fetch(`models/${modelData.archivo}`);
            if (!response.ok) throw new Error("No se pudo descargar el archivo .dxf");
            const text = await response.text();

            // C. Parsear
            showLoading('Parseando DXF...');
            const parser = new window.DxfParser();
            const dxf = parser.parseSync(text);

            // D. Detectar 3D
            is2DModel = !detectIs3D(dxf.entities);

            // E. Construir geometrías
            modelGroup = buildDXFGeometries(dxf);
            modelGroup.rotation.x = -Math.PI / 2; // AutoCAD usa Z arriba, Three.js usa Y arriba
            scene.add(modelGroup);

            // F. Organizar capas y calcular límites
            processLayers(modelGroup);
            
            const box = new THREE.Box3().setFromObject(modelGroup);
            box.getCenter(modelCenter);
            box.getSize(modelSize);
            modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

            // G. Aplicar UI y resetear cámara
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
            let mesh;

            // Entidades básicas
            if (entity.type === 'LINE') {
                const geo = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(entity.vertices[0].x, entity.vertices[0].y, entity.vertices[0].z || 0),
                    new THREE.Vector3(entity.vertices[1].x, entity.vertices[1].y, entity.vertices[1].z || 0)
                ]);
                mesh = new THREE.Line(geo, mat);
            } else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
                const points = entity.vertices.map(v => new THREE.Vector3(v.x, v.y, v.z || 0));
                if (entity.shape || entity.closed) points.push(points[0]);
                const geo = new THREE.BufferGeometry().setFromPoints(points);
                mesh = new THREE.Line(geo, mat);
            } else if (entity.type === 'CIRCLE') {
                const curve = new THREE.EllipseCurve(entity.center.x, entity.center.y, entity.radius, entity.radius);
                const points = curve.getPoints(64).map(p => new THREE.Vector3(p.x, p.y, entity.center.z || 0));
                const geo = new THREE.BufferGeometry().setFromPoints(points);
                mesh = new THREE.Line(geo, mat);
            }
            // Soporte para Hatch básico (como líneas de contorno por ahora)
            else if (entity.type === 'HATCH') {
                // El parser entrega los loops del hatch
                entity.loops.forEach(loop => {
                    // Aquí podrías usar ShapeGeometry para rellenar, por ahora contorno:
                    const points = loop.entities.flatMap(e => {
                        if (e.type === 'LINE') return [new THREE.Vector3(e.vertices[0].x, e.vertices[0].y, 0), new THREE.Vector3(e.vertices[1].x, e.vertices[1].y, 0)];
                        return [];
                    });
                    if (points.length > 0) {
                        const geo = new THREE.BufferGeometry().setFromPoints(points);
                        group.add(new THREE.Line(geo, mat));
                    }
                });
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
            if (child.isLine || child.isMesh) groundMeshes.push(child);
        });
    }

    // ── 4. CÁMARAS Y ANIMACIÓN (SIMILAR A TU 3DM) ───────────────────────────

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
            orbitControls.enableRotate = false; // Bloqueado a 2D
            syncOrthoCamera();
        }
        updateModeUI();
    }

    function syncOrthoCamera() {
        if (!orthoCamera) return;
        const aspect = window.innerWidth / window.innerHeight;
        const halfH = modelSpan * 0.8, halfW = halfH * aspect;
        orthoCamera.left = -halfW; orthoCamera.right = halfW;
        orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
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