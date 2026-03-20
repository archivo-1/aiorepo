// viewer-ifc.js
(function () {
  'use strict';

  // ── Escena y cámaras ──────────────────────────────────────────────
  let scene, renderer;
  let orbitCamera, walkCamera, flyCamera, orthoCamera, activeCamera, orbitControls;
  let cameraMode = 'orbit';
  let isOrthoOrbit = false;
  let is2DModel = false;

  let modelGroup = null;
  let groundMeshes = [];
  let modelSize = new THREE.Vector3();
  let modelSpan = 10;
  let modelCenter = new THREE.Vector3();

  const raycaster = new THREE.Raycaster();
  const downVec = new THREE.Vector3(0, -1, 0);

  const keys = {};
  const velocity = new THREE.Vector3();
  const damping = 0.85;
  let yaw = 0, pitch = 0;
  const WALK_HEIGHT = 1.7;

  // ── Capas / categorías ────────────────────────────────────────────
  let layerMeshes = {};

  // ── Estilos visuales ──────────────────────────────────────────────
  let visualStyle = 'rendered';
  const meshMatCache = {};
  const LAYER_OVERRIDES = {
    glass: { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
    window: { color: 0xadd8f7, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 },
    water: { color: 0x1a6fa8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75 },
    ocean: { color: 0x1a6fa8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75 },
    terrain: { color: 0x8a7560, roughness: 0.9, metalness: 0.0 },
    ground: { color: 0x8a7560, roughness: 0.9, metalness: 0.0 },
    metal: { color: 0x888888, roughness: 0.3, metalness: 0.85 },
    steel: { color: 0x888888, roughness: 0.3, metalness: 0.85 },
    concrete: { color: 0xb0a898, roughness: 0.85, metalness: 0.0 }
  };

  // ── Entorno / luz ─────────────────────────────────────────────────
  let sun, fill, sky, skyUniforms;

  // ── Helpers DOM ───────────────────────────────────────────────────
  function qs(sel) {
    return document.querySelector(sel);
  }
  function qsa(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  function showLoading(msg, detail) {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.remove('hidden');
    const p = el.querySelector('p');
    if (p && msg) p.textContent = msg;
    const span = document.getElementById('loading-detail');
    if (span && detail) span.textContent = detail;
  }

  function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.classList.add('hidden');
  }

  // ── Querystring ───────────────────────────────────────────────────
  function getIdFromQuery() {
    const p = new URLSearchParams(window.location.search);
    return p.get('id') || null;
  }

  // ── Entorno y fondo ───────────────────────────────────────────────
  function initSky() {
    if (sky) return;
    sky = new THREE.Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);
    skyUniforms = sky.material.uniforms;
    skyUniforms['turbidity'].value = 10;
    skyUniforms['rayleigh'].value = 3;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.7;
  }

  function updateSun() {
    if (!sun) return;
    const az = parseFloat(qs('#sun-az').value);
    const el = parseFloat(qs('#sun-el').value);
    const azEl = document.getElementById('az-val');
    const elEl = document.getElementById('el-val');
    if (azEl) azEl.textContent = az + '°';
    if (elEl) elEl.textContent = el + '°';

    const phi = (90 - el) * (Math.PI / 180);
    const theta = (az + 180) * (Math.PI / 180);
    const dist = modelSpan * 2.5;

    sun.position.set(
      modelCenter.x + dist * Math.sin(phi) * Math.cos(theta),
      modelCenter.y + dist * Math.cos(phi),
      modelCenter.z + dist * Math.sin(phi) * Math.sin(theta)
    );
    sun.target.position.copy(modelCenter);
    sun.target.updateMatrixWorld();

    if (skyUniforms) {
      skyUniforms['sunPosition'].value.copy(sun.position);
    }

    const d = modelSpan * 1.5;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.updateProjectionMatrix();
  }

  function changeBackground(type) {
    if (!scene) return;

    if (sky) {
      scene.remove(sky);
      sky = null;
      skyUniforms = null;
    }

    if (type === 'black') {
      scene.background = new THREE.Color(0x050608);
    } else if (type === 'white') {
      scene.background = new THREE.Color(0xffffff);
    } else if (type === 'grey') {
      scene.background = new THREE.Color(0x22262e);
    } else if (type === 'sky' || type === 'sunset') {
      initSky();
      if (type === 'sunset') {
        qs('#sun-el').value = 2;
        qs('#sun-az').value = 180;
        skyUniforms['turbidity'].value = 20;
        skyUniforms['rayleigh'].value = 2;
      } else {
        skyUniforms['turbidity'].value = 10;
        skyUniforms['rayleigh'].value = 3;
      }
      updateSun();
      scene.background = null;
    } else if (type === 'gradient') {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0, '#020617');
      grad.addColorStop(1, '#1e293b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 2, 512);
      scene.background = new THREE.CanvasTexture(canvas);
    }
  }
  window.changeBackground = changeBackground;

  function toggleShadows(enabled) {
    if (!renderer || !sun) return;
    sun.castShadow = enabled;
    if (modelGroup) {
      modelGroup.traverse(function (obj) {
        if (obj.isMesh) {
          obj.castShadow = obj.receiveShadow = enabled;
        }
      });
    }
  }

  // ── Cámara y navegación ───────────────────────────────────────────
  function updateModeUI() {
    const labels = { orbit: 'Orbit', walk: 'Walk', fly: 'Fly', ortho: 'Top View' };
    const el = document.getElementById('mode-label');
    if (el) el.textContent = labels[cameraMode] || cameraMode;
    qsa('.cam-btn[data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === cameraMode);
    });
    document.dispatchEvent(new CustomEvent('modchange', { detail: cameraMode }));
  }

  function getGroundY(x, z) {
    if (groundMeshes.length === 0) return modelCenter.y;
    const origin = new THREE.Vector3(x, modelCenter.y + modelSpan * 5, z);
    raycaster.set(origin, downVec);
    const hits = raycaster.intersectObjects(groundMeshes, false);
    return hits.length > 0 ? hits[0].point.y : modelCenter.y;
  }

  function checkCollision(pos, radius) {
    if (groundMeshes.length === 0) return false;
    const dirs = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1)
    ];
    for (let h of [0.5, WALK_HEIGHT, WALK_HEIGHT * 0.8]) {
      const p = pos.clone();
      p.y = pos.y - WALK_HEIGHT + h;
      for (let d of dirs) {
        raycaster.set(p, d);
        const hits = raycaster.intersectObjects(groundMeshes, false);
        if (hits.length > 0 && hits[0].distance < radius) return true;
      }
    }
    return false;
  }

  function syncOrthoCamera() {
    if (!orthoCamera) return;
    const aspect = window.innerWidth / window.innerHeight;
    const halfH = modelSpan * 0.7;
    const halfW = halfH * aspect;
    orthoCamera.left = -halfW;
    orthoCamera.right = halfW;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;

    if (cameraMode === 'orbit' && isOrthoOrbit) {
      const dir = new THREE.Vector3().subVectors(orbitCamera.position, orbitControls.target).normalize();
      orthoCamera.position.copy(orbitControls.target).addScaledVector(dir, modelSpan * 5);
      orthoCamera.lookAt(orbitControls.target);
    } else {
      orthoCamera.position.set(modelCenter.x, modelCenter.y + modelSpan * 5, modelCenter.z);
      orthoCamera.lookAt(modelCenter);
    }

    orthoCamera.updateProjectionMatrix();
  }

  function setCameraMode(mode) {
    if (is2DModel && mode !== 'ortho') return;
    const prev = cameraMode;
    cameraMode = mode;

    if ((prev === 'walk' || prev === 'fly') && document.pointerLockElement) {
      document.exitPointerLock();
    }

    if (mode === 'orbit') {
      activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
      orbitControls.object = activeCamera;
      orbitControls.enabled = true;
      orbitControls.enableRotate = true;
      orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      };
    } else if (mode === 'walk') {
      activeCamera = walkCamera;
      orbitControls.enabled = false;
      const target = orbitControls.target.clone();
      const groundY = getGroundY(target.x, target.z);
      walkCamera.position.set(target.x, groundY + WALK_HEIGHT, target.z + modelSpan * 0.05);
      walkCamera.rotation.set(0, 0, 0, 'YXZ');
      yaw = 0;
      pitch = 0;
    } else if (mode === 'fly') {
      activeCamera = flyCamera;
      orbitControls.enabled = false;
      flyCamera.position.copy(orbitCamera.position);
      flyCamera.lookAt(orbitControls.target);
      yaw = flyCamera.rotation.y;
      pitch = flyCamera.rotation.x;
    } else if (mode === 'ortho') {
      activeCamera = orthoCamera;
      orbitControls.object = orthoCamera;
      orbitControls.enabled = true;
      orbitControls.enableRotate = false;
      orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      };
      syncOrthoCamera();
    }

    velocity.set(0, 0, 0);
    updateModeUI();
  }
  window.setCameraMode = setCameraMode;

  function toggleOrtho() {
    isOrthoOrbit = !isOrthoOrbit;
    const btn = document.getElementById('ortho-toggle');
    if (btn) btn.classList.toggle('active', isOrthoOrbit);
    if (cameraMode === 'orbit') {
      activeCamera = isOrthoOrbit ? orthoCamera : orbitCamera;
      if (isOrthoOrbit) syncOrthoCamera();
      orbitControls.object = activeCamera;
      orbitControls.update();
    }
  }
  window.toggleOrtho = toggleOrtho;

  function resetCamera() {
    if (!modelGroup) return;
    isOrthoOrbit = false;
    const btn = document.getElementById('ortho-toggle');
    if (btn) btn.classList.remove('active');

    const d = modelSpan;
    orbitCamera.position.set(
      modelCenter.x + d * 1.4,
      modelCenter.y + d * 1.2,
      modelCenter.z + d * 1.4
    );
    orbitControls.target.copy(modelCenter);
    activeCamera = orbitCamera;
    orbitControls.object = activeCamera;
    orbitControls.update();

    if (cameraMode === 'ortho') {
      syncOrthoCamera();
    }
  }
  window.resetCamera = resetCamera;

  // ── Estilos / materiales ───────────────────────────────────────────
  function buildMatSet(hexColor, layerName) {
    const lname = (layerName || '').toLowerCase();
    let ovr = null;
    Object.keys(LAYER_OVERRIDES).forEach(k => {
      if (!ovr && lname.indexOf(k) !== -1) ovr = LAYER_OVERRIDES[k];
    });

    const rendParams = ovr
      ? Object.assign({ side: THREE.DoubleSide }, ovr)
      : {
          color: hexColor,
          roughness: 0.72,
          metalness: 0.05,
          side: THREE.DoubleSide
        };

    rendParams.polygonOffset = true;
    rendParams.polygonOffsetFactor = 1;
    rendParams.polygonOffsetUnits = 1;

    return {
      rendered: new THREE.MeshStandardMaterial(rendParams),
      clay: new THREE.MeshStandardMaterial({
        color: 0xd4c5b0,
        roughness: 0.75,
        metalness: 0.0,
        side: THREE.DoubleSide
      }),
      wireframe: new THREE.MeshStandardMaterial({
        color: hexColor,
        wireframe: true,
        side: THREE.DoubleSide
      }),
      xray: new THREE.MeshStandardMaterial({
        color: hexColor,
        transparent: true,
        opacity: 0.18,
        roughness: 0.3,
        metalness: 0.0,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    };
  }

  function applyStyle(style) {
    visualStyle = style;
    qsa('.style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
    if (!modelGroup) return;
    modelGroup.traverse(obj => {
      if (obj.isMesh && meshMatCache[obj.uuid]) {
        obj.material = meshMatCache[obj.uuid][style] || meshMatCache[obj.uuid].rendered;
      }
    });
  }
  window.applyStyle = applyStyle;

  function updateLayersUI() {
    const list = document.getElementById('layers-list');
    if (!list) return;
    list.innerHTML = '';

    const names = Object.keys(layerMeshes).sort();
    if (names.length === 0) {
      list.textContent = 'Sin capas BIM disponibles.';
      return;
    }

    names.forEach(name => {
      const row = document.createElement('div');
      row.className = 'layer-item';

      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', () => {
        const meshes = layerMeshes[name];
        meshes.forEach(m => {
          m.visible = cb.checked;
        });
      });

      const span = document.createElement('span');
      span.textContent = name;

      label.appendChild(cb);
      label.appendChild(span);
      row.appendChild(label);
      list.appendChild(row);
    });
  }

  // ── Renderer y cámaras ─────────────────────────────────────────────
  function initRendererAndCameras() {
    const canvas = document.getElementById('three-canvas');

    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true
    });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020617);

    const aspect = window.innerWidth / window.innerHeight;

    orbitCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 2000);
    walkCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 2000);
    flyCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 4000);
    orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 4000);

    activeCamera = orbitCamera;

    orbitControls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.06;
    orbitControls.rotateSpeed = 0.9;
    orbitControls.zoomSpeed = 1.0;
    orbitControls.panSpeed = 0.8;

    sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(50, 100, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    sun.target.position.set(0, 0, 0);
    scene.add(sun.target);

    fill = new THREE.HemisphereLight(0xeeeeff, 0x111322, 0.4);
    scene.add(fill);

    changeBackground('gradient');

    const shadowsToggle = document.getElementById('shadows-toggle');
    if (shadowsToggle) {
      shadowsToggle.addEventListener('change', () => {
        toggleShadows(shadowsToggle.checked);
      });
    }

    ['sun-az', 'sun-el'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateSun);
      }
    });

    window.addEventListener('resize', onWindowResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    animate();
  }

  function onWindowResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);

    [orbitCamera, walkCamera, flyCamera].forEach(cam => {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    });

    syncOrthoCamera();
  }

  function onKeyDown(e) {
    keys[e.code] = true;
    if (e.code === 'KeyR') {
      resetCamera();
    }
  }

  function onKeyUp(e) {
    keys[e.code] = false;
  }

  function updateFirstPerson(dt) {
    if (cameraMode !== 'walk' && cameraMode !== 'fly') return;

    const cam = activeCamera;
    if (!cam) return;

    const speed = cameraMode === 'walk' ? modelSpan * 0.25 : modelSpan * 0.6;
    const dampingFactor = Math.pow(damping, dt * 60);

    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    cam.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    let move = new THREE.Vector3();

    if (keys['KeyW']) move.add(forward);
    if (keys['KeyS']) move.sub(forward);
    if (keys['KeyA']) move.sub(right);
    if (keys['KeyD']) move.add(right);

    if (cameraMode === 'fly') {
      if (keys['Space']) move.y += 1;
      if (keys['ShiftLeft'] || keys['ShiftRight']) move.y -= 1;
    }

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      velocity.add(move);
    }

    velocity.multiplyScalar(dampingFactor);

    const nextPos = cam.position.clone().add(velocity);
    if (cameraMode === 'walk') {
      const radius = modelSpan * 0.02;
      if (!checkCollision(nextPos, radius)) {
        const groundY = getGroundY(nextPos.x, nextPos.z);
        nextPos.y = groundY + WALK_HEIGHT;
        cam.position.copy(nextPos);
      }
    } else {
      cam.position.copy(nextPos);
    }
  }

  function animate() {
    requestAnimationFrame(animate);

    const dt = 1 / 60;

    if (orbitControls && (cameraMode === 'orbit' || cameraMode === 'ortho')) {
      orbitControls.update();
    }

    updateFirstPerson(dt);

    renderer.render(scene, activeCamera);
  }

  // ── content.json y colecciones ─────────────────────────────────────
  let currentItem = null;
  let allItems = [];

  async function loadContentJson() {
    const res = await fetch('content.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('No se pudo cargar content.json');
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('content.json no es un array');
    allItems = data;
  }

  function findItemById(id) {
    return allItems.find(it => it.id === id) || null;
  }

  function buildModelUrl(archivo) {
    if (/^https?:\/\//i.test(archivo)) return archivo;
    if (archivo.startsWith('models/')) return archivo;
    return 'models/' + archivo;
  }

  function populateHeaderAndCollection() {
    if (!currentItem) return;

    const titleEl = document.getElementById('model-title');
    if (titleEl) {
      titleEl.textContent = currentItem.nombre || '(Sin nombre)';
    }

    const breadcrumbs = document.getElementById('breadcrumbs');
    if (breadcrumbs) {
      const catLabel = currentItem.categoria === 'modelo-3d' ? 'Modelo BIM' : currentItem.categoria;
      breadcrumbs.textContent = (currentItem.coleccion || 'Proyecto') + ' · ' + catLabel;
    }

    const collNameEl = document.getElementById('collection-name');
    if (collNameEl) {
      collNameEl.textContent = currentItem.coleccion || 'Sin colección';
    }

    const relatedList = document.getElementById('related-list');
    if (!relatedList) return;
    relatedList.innerHTML = '';

    if (!currentItem.coleccion) {
      relatedList.textContent = 'Este elemento no pertenece a ninguna colección.';
      return;
    }

    const others = allItems.filter(
      it => it.coleccion === currentItem.coleccion && it.id !== currentItem.id
    );

    if (others.length === 0) {
      relatedList.textContent = 'No hay otros elementos en esta colección.';
      return;
    }

    others.forEach(it => {
      const div = document.createElement('div');
      div.className = 'related-item';

      const a = document.createElement('a');
      a.textContent = it.nombre || it.id;

      const ext = String(it.archivo || '').split('.').pop().toLowerCase();

      if (it.categoria === 'modelo-3d') {
        if (ext === 'ifc') {
          a.href = 'viewer-ifc.html?id=' + encodeURIComponent(it.id);
        } else {
          a.href = 'viewer.html?id=' + encodeURIComponent(it.id);
        }
      } else if (it.categoria === 'mapa') {
        a.href = 'viewer-map.html?id=' + encodeURIComponent(it.id);
      } else if (it.categoria === 'video') {
        a.href = 'viewer-media.html?id=' + encodeURIComponent(it.id);
      } else if (it.categoria === 'pdf') {
        a.href = it.archivo;
        a.target = '_blank';
        a.rel = 'noopener';
      } else if (it.categoria === 'enlace') {
        a.href = it.archivo;
        a.target = '_blank';
        a.rel = 'noopener';
      } else {
        a.href = it.archivo || '#';
      }

      div.appendChild(a);
      relatedList.appendChild(div);
    });
  }

  // ── IFC loader ─────────────────────────────────────────────────────
  let ifcLoader = null;

  function initIfcLoader() {
    if (!window.WebIFCThree || !WebIFCThree.IFCLoader) {
      console.warn('web-ifc-three no está disponible. Revisa el <script> del CDN.');
      return;
    }

    ifcLoader = new WebIFCThree.IFCLoader();

    if (ifcLoader.ifcManager && ifcLoader.ifcManager.setWasmPath) {
      // Aquí puedes seguir usando tus wasm locales
      ifcLoader.ifcManager.setWasmPath('libs/ifc/');
    }
  }

  function classifyIfcItemName(ifcType, rawName) {
    const t = (ifcType || '').toUpperCase();
    if (t.includes('WALL')) return 'Muros';
    if (t.includes('SLAB')) return 'Losas';
    if (t.includes('FLOOR')) return 'Pisos';
    if (t.includes('ROOF')) return 'Cubiertas';
    if (t.includes('WINDOW')) return 'Ventanas';
    if (t.includes('DOOR')) return 'Puertas';
    if (t.includes('COLUMN')) return 'Columnas';
    if (t.includes('BEAM')) return 'Vigas';
    if (t.includes('RAMP')) return 'Rampas';
    if (t.includes('STAIR')) return 'Escaleras';
    if (t.includes('SPACE')) return 'Espacios';
    if (t.includes('SITE')) return 'Sitio';
    if (t.includes('BUILDING')) return 'Edificio';
    if (t.includes('STOREY')) return 'Niveles';
    return rawName || t || 'Otros';
  }

  function classifyLayerForMaterials(layerName) {
    const ln = (layerName || '').toLowerCase();
    if (ln.includes('ventan')) return 'glass';
    if (ln.includes('glass')) return 'glass';
    if (ln.includes('losa') || ln.includes('piso') || ln.includes('slab')) return 'concrete';
    if (ln.includes('muro') || ln.includes('wall')) return 'concrete';
    if (ln.includes('cubierta') || ln.includes('roof')) return 'concrete';
    if (ln.includes('terreno') || ln.includes('site') || ln.includes('terrain')) return 'terrain';
    if (ln.includes('acero') || ln.includes('steel') || ln.includes('metal')) return 'steel';
    return '';
  }

  function computeModelBoundsAndGround() {
    if (!modelGroup) return;

    const box = new THREE.Box3().setFromObject(modelGroup);
    box.getSize(modelSize);
    box.getCenter(modelCenter);
    modelSpan = Math.max(modelSize.x, modelSize.y, modelSize.z) || 10;

    groundMeshes = [];
    modelGroup.traverse(obj => {
      if (obj.isMesh) {
        const name = (obj.name || '').toLowerCase();
        if (name.includes('slab') || name.includes('floor') || name.includes('ground') || name.includes('terrain')) {
          groundMeshes.push(obj);
        }
      }
    });

    if (groundMeshes.length === 0) {
      modelGroup.traverse(obj => {
        if (obj.isMesh) groundMeshes.push(obj);
      });
    }

    resetCamera();
    updateSun();
  }

  function attachMaterialsAndLayersToIfcGroup(ifcScene) {
    if (modelGroup) {
      scene.remove(modelGroup);
    }
    modelGroup = ifcScene;
    scene.add(modelGroup);

    layerMeshes = {};
    const defaultColor = new THREE.Color(0xd1d5db);

    modelGroup.traverse(obj => {
      if (!obj.isMesh) return;

      const baseColor = obj.material && obj.material.color
        ? obj.material.color.getHex()
        : defaultColor.getHex();

      let layerName = obj.name || '';

      const matLayerKey = classifyLayerForMaterials(layerName) || layerName.toLowerCase();

      if (!meshMatCache[obj.uuid]) {
        meshMatCache[obj.uuid] = buildMatSet(baseColor, matLayerKey);
      }
      obj.material = meshMatCache[obj.uuid][visualStyle];

      if (!layerMeshes[layerName]) layerMeshes[layerName] = [];
      layerMeshes[layerName].push(obj);

      obj.castShadow = true;
      obj.receiveShadow = true;
    });

    updateLayersUI();
    computeModelBoundsAndGround();
  }

  async function loadIfcModel(url) {
    if (!ifcLoader) {
      initIfcLoader();
    }
    if (!ifcLoader) {
      throw new Error('No se pudo inicializar IFC Loader.');
    }

    showLoading('Cargando modelo IFC...', url);

    let ifcScene;
    try {
      ifcScene = await ifcLoader.loadAsync(url);
    } catch (err) {
      console.error(err);
      throw new Error('Error cargando IFC: ' + (err.message || err));
    }

    hideLoading();
    attachMaterialsAndLayersToIfcGroup(ifcScene);
  }

  // ── Init ───────────────────────────────────────────────────────────
  async function init() {
    showLoading('Cargando modelo IFC...', 'Leyendo configuración');
    initRendererAndCameras();

    const id = getIdFromQuery();
    if (!id) {
      showLoading('Sin ID en la URL', 'Agrega ?id=algo en la dirección');
      return;
    }

    try {
      await loadContentJson();
    } catch (err) {
      console.error(err);
      showLoading('Error leyendo content.json', err.message || 'Revisa la consola');
      return;
    }

    currentItem = findItemById(id);
    if (!currentItem) {
      showLoading('Elemento no encontrado', 'ID: ' + id);
      return;
    }

    populateHeaderAndCollection();

    const archivo = currentItem.archivo || '';
    const ext = archivo.split('.').pop().toLowerCase();
    if (ext !== 'ifc') {
      showLoading('El archivo no es IFC', 'Extensión: ' + ext);
      return;
    }

    const url = buildModelUrl(archivo);

    try {
      await loadIfcModel(url);
    } catch (err) {
      console.error(err);
      showLoading('Error cargando IFC', err.message || 'Revisa la consola');
      return;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
