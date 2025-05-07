import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let currentModel = null;
let autoRotate = false;
let modelCache = new Map();
let textureLoader;
let dracoLoader;
let gltfLoader;

// Model mapping with exact filenames
const modelMapping = {
    'regular-tshirt': '3d-basic-t-shirt.glb',
    'oversized-tshirt': '3d-basic-t-shirt.glb',
    'cropped-tshirt': '3d-cropped-boxy-t-shirt.glb',
    'sweatshirt': '3d-oversized-sweatshirt.glb',
    'hoodie': '3d-oversized-hoodie.glb',
    'zip-hoodie': '3d-oversized-zip-hoodie.glb',
    'polo': '3d-oversized-polo-t-shirt.glb'
};

// --- 3D Painting Logic ---
let baseCanvas, baseCtx, paintCanvas, paintCtx, paintTexture, paintMesh;
let hasPainting = false; // Track if any painting has occurred
let maskCanvas, maskCtx; // For inpainting mask
let paintMeshCandidates = [];
let paintMeshCandidateIndex = 0;

function setupPaintTexture(mesh) {
    // Determine canvas size based on original texture
    let originalMap = mesh.material.map && mesh.material.map.image ? mesh.material.map.image : null;
    let texWidth = 1024, texHeight = 1024;
    if (originalMap && originalMap.width && originalMap.height) {
        texWidth = originalMap.width;
        texHeight = originalMap.height;
    }
    // Create a base canvas for the original texture
    baseCanvas = document.createElement('canvas');
    baseCanvas.width = texWidth;
    baseCanvas.height = texHeight;
    baseCtx = baseCanvas.getContext('2d');
    if (!baseCtx) {
        console.error('Failed to get 2D context for baseCanvas');
        return;
    }
    // Copy the original texture to the base canvas
    if (originalMap) {
        baseCtx.drawImage(originalMap, 0, 0, texWidth, texHeight);
    } else {
        baseCtx.fillStyle = 'rgba(0,0,0,0)';
        baseCtx.fillRect(0, 0, texWidth, texHeight);
    }
    // Create a separate paint canvas for dynamic painting
    paintCanvas = document.createElement('canvas');
    paintCanvas.width = texWidth;
    paintCanvas.height = texHeight;
    paintCtx = paintCanvas.getContext('2d');
    if (!paintCtx) {
        console.error('Failed to get 2D context for paintCanvas');
        return;
    }
    paintCtx.clearRect(0, 0, texWidth, texHeight);
    // --- Mask canvas for inpainting ---
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = texWidth;
    maskCanvas.height = texHeight;
    maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
        console.error('Failed to get 2D context for maskCanvas');
        return;
    }
    // Fill mask with black
    maskCtx.fillStyle = 'rgb(0,0,0)';
    maskCtx.fillRect(0, 0, texWidth, texHeight);
    // Compose base + paint onto a display canvas for the mesh
    let displayCanvas = document.createElement('canvas');
    displayCanvas.width = texWidth;
    displayCanvas.height = texHeight;
    let displayCtx = displayCanvas.getContext('2d');
    if (!displayCtx) {
        console.error('Failed to get 2D context for displayCanvas');
        return;
    }
    displayCtx.drawImage(baseCanvas, 0, 0);
    displayCtx.globalCompositeOperation = 'source-over';
    displayCtx.drawImage(paintCanvas, 0, 0);
    paintTexture = new THREE.CanvasTexture(displayCanvas);
    paintTexture.needsUpdate = true;
    mesh.material.map = paintTexture;
    mesh.material.needsUpdate = true;
    paintMesh = mesh;
    // Store displayCanvas for later updates
    mesh._displayCanvas = displayCanvas;
    mesh._displayCtx = displayCtx;
    // Store texture size for UV mapping
    mesh._texWidth = texWidth;
    mesh._texHeight = texHeight;
    // Expose paintCanvas globally for export
    window.paintCanvas = paintCanvas;
    // Expose maskCanvas for export
    window.maskCanvas = maskCanvas;
    // Force paint texture assignment after setup
    if (mesh.material && paintTexture) {
        mesh.material.map = paintTexture;
        mesh.material.needsUpdate = true;
    }
    // Log world position and scale
    mesh.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    const worldScale = new THREE.Vector3();
    mesh.getWorldScale(worldScale);
    console.log('Paint mesh world position:', worldPos, 'world scale:', worldScale);
    // Ensure paintMesh is attached to the scene graph
    if (mesh.parent == null) {
        if (currentModel) {
            currentModel.add(mesh);
            console.warn('paintMesh was not attached to scene, added to currentModel.');
        } else {
            scene.add(mesh);
            console.warn('paintMesh was not attached to scene, added to scene.');
        }
    }
}

function updateDisplayTexture() {
    if (!paintMesh || !paintMesh._displayCtx) return;
    // Redraw base + paint onto display canvas
    paintMesh._displayCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    paintMesh._displayCtx.drawImage(baseCanvas, 0, 0);
    paintMesh._displayCtx.globalCompositeOperation = 'source-over';
    paintMesh._displayCtx.drawImage(paintCanvas, 0, 0);
    paintTexture.needsUpdate = true;
}

function paintOnUV(uv, color = 'rgba(99,102,241,0.7)', size = 30) {
    if (!paintCtx || !paintMesh) return;
    // Debug: check if UVs are normalized
    if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) {
        console.warn('UV out of bounds:', uv);
    }
    // Use the actual texture size for mapping
    const texWidth = paintMesh._texWidth || paintCanvas.width;
    const texHeight = paintMesh._texHeight || paintCanvas.height;
    const x = uv.x * texWidth;
    const y = (1 - uv.y) * texHeight; // Flip Y for canvas
    paintCtx.save();
    paintCtx.globalAlpha = 1.0;
    paintCtx.beginPath();
    paintCtx.arc(x, y, size, 0, 2 * Math.PI);
    paintCtx.fillStyle = color;
    paintCtx.fill();
    paintCtx.restore();
    // --- Also paint on maskCanvas for inpainting ---
    if (maskCtx) {
        maskCtx.save();
        maskCtx.globalAlpha = 1.0;
        maskCtx.beginPath();
        maskCtx.arc(x, y, size, 0, 2 * Math.PI);
        maskCtx.fillStyle = 'rgb(255,255,255)';
        maskCtx.fill();
        maskCtx.restore();
    }
    updateDisplayTexture();
    hasPainting = true;
    // Ensure the painted texture is always assigned and updated
    if (paintMesh && paintTexture) {
        paintMesh.material.map = paintTexture;
        paintMesh.material.needsUpdate = true;
        paintTexture.needsUpdate = true;
    }
}

// Raycaster for painting
const raycaster = new THREE.Raycaster();
let paintingEnabled = false;
let paintingColor = 'rgba(99,102,241,0.7)';
let paintingSize = 30;

function enable3DPainting(enable, color, size) {
    paintingEnabled = enable;
    if (color) paintingColor = color;
    if (size) paintingSize = size;
    // Attach or remove 3D painting events based on enable
    const dom = renderer && renderer.domElement;
    if (dom) {
        if (enable) {
            dom.addEventListener('pointerdown', on3DPointerDown);
            dom.addEventListener('pointermove', on3DPointerMove);
            dom.addEventListener('pointerup', on3DPointerUp);
            dom.addEventListener('pointerleave', on3DPointerUp);
        } else {
            dom.removeEventListener('pointerdown', on3DPointerDown);
            dom.removeEventListener('pointermove', on3DPointerMove);
            dom.removeEventListener('pointerup', on3DPointerUp);
            dom.removeEventListener('pointerleave', on3DPointerUp);
        }
    }
}

// --- Improved 3D painting: allow continuous painting with pointermove ---
let is3DPainting = false;
function on3DPointerDown(event) {
    if (!paintingEnabled || !paintMesh) return;
    is3DPainting = true;
    paintAtPointer(event);
}
function on3DPointerMove(event) {
    if (!paintingEnabled || !paintMesh || !is3DPainting) return;
    paintAtPointer(event);
}
function on3DPointerUp(event) {
    is3DPainting = false;
    // Show confirmation popup after painting
    if (typeof window.showMaskConfirmPopup === 'function') {
        window.showMaskConfirmPopup();
    }
}

function paintAtPointer(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    // Correct mouse normalization for raycaster
    const mouse = {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((event.clientY - rect.top) / rect.height) * 2 + 1
    };
    console.log('Pointer event:', { clientX: event.clientX, clientY: event.clientY, mouseNDC: mouse });
    raycaster.setFromCamera(mouse, camera);
    // Debug: Raycast against all meshes in currentModel
    let allHits = [];
    if (currentModel) {
        currentModel.traverse((node) => {
            if (node.isMesh) {
                const hits = raycaster.intersectObject(node, false);
                if (hits.length > 0) {
                    allHits.push({ mesh: node.name, hits });
                }
            }
        });
    }
    console.log('Raycaster all mesh hits:', allHits);
    // Continue with normal paintMesh logic
    const intersects = raycaster.intersectObject(paintMesh, false);
    console.log('Raycaster intersects:', intersects);
    if (intersects.length > 0 && intersects[0].uv) {
        // Always use white for inpainting mask
        const colorToUse = inpaintingMode ? 'rgb(255,255,255)' : paintingColor;
        paintOnUV(intersects[0].uv, colorToUse, paintingSize);
        // Ensure the painted texture is always assigned and updated
        if (paintMesh && paintTexture) {
            paintMesh.material.map = paintTexture;
            paintMesh.material.needsUpdate = true;
            paintTexture.needsUpdate = true;
            console.log('Assigned paintTexture to paintMesh.material.map and set needsUpdate.');
        }
    }
}

function attach3DPaintEvents() {
    renderer.domElement.addEventListener('pointerdown', on3DPointerDown);
    renderer.domElement.addEventListener('pointermove', on3DPointerMove);
    renderer.domElement.addEventListener('pointerup', on3DPointerUp);
    renderer.domElement.addEventListener('pointerleave', on3DPointerUp);
}

// --- End 3D Painting Logic ---

function initLoaders() {
    // Initialize texture loader
    textureLoader = new THREE.TextureLoader();

    // Initialize DRACO loader
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    dracoLoader.preload();

    // Initialize GLTF loader
    gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);
}

function disposeModel(model) {
    if (!model) return;

    model.traverse((node) => {
        if (node.isMesh) {
            if (node.geometry) {
                node.geometry.dispose();
            }
            if (node.material) {
                if (Array.isArray(node.material)) {
                    node.material.forEach(material => disposeMaterial(material));
                } else {
                    disposeMaterial(node.material);
                }
            }
        }
    });
}

function disposeMaterial(material) {
    if (!material) return;

    // Dispose textures
    Object.values(material).forEach(value => {
        if (value && value.isTexture) {
            value.dispose();
        }
    });

    material.dispose();
}

function init() {
    initLoaders();

    const container = document.getElementById('three-container');
    if (!container) {
        console.error('Three.js container not found');
        return;
    }

    // Scene setup with transparent background
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xE5E5E5); // Set to light grey by default

    // Camera setup with safe distance
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    const aspect = width / height;

    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    camera.position.set(0, 1, 5);
    camera.lookAt(0, 0, 0);

    // Enhanced renderer settings with alpha
    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
    });

    renderer.setSize(width, height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.5;
    renderer.setClearColor(0xE5E5E5, 1); // Set renderer clear color to light grey by default
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // High contrast lighting setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7); // Increased ambient for visibility
    scene.add(ambientLight);

    // Main light
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
    mainLight.position.set(5, 5, 5); // Moved further out
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.camera.near = 0.1;
    mainLight.shadow.camera.far = 30;
    mainLight.shadow.bias = -0.0001;
    scene.add(mainLight);

    // Fill light
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
    fillLight.position.set(-5, 0, -5);
    scene.add(fillLight);

    // Controls with safe distances
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 3; // Prevent camera from getting too close
    controls.maxDistance = 10;
    controls.maxPolarAngle = Math.PI / 2;
    controls.target.set(0, 0, 0); // Always orbit around center
    controls.autoRotate = true; // Enable automatic rotation
    controls.update();
    window.controls = controls; // Expose controls globally

    window.addEventListener('resize', onWindowResize, false);

    const urlParams = new URLSearchParams(window.location.search);
    const productType = urlParams.get('product') || 'regular-tshirt';
    const mappedModel = modelMapping[productType] || '3d-basic-t-shirt.glb';
    loadModel(mappedModel);

    animate();
}

async function loadModel(modelFile) {
    const container = document.getElementById('three-container');
    if (!container) return;

    try {
        // Check cache first
        if (modelCache.has(modelFile)) {
            console.log('Loading model from cache:', modelFile);
            updateScene(modelCache.get(modelFile).clone());
            return;
        }

        // Show loading message
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading-model';
        loadingDiv.textContent = 'Loading 3D Model...';
        container.appendChild(loadingDiv);

        const modelPath = `models/${modelFile}`;
        console.log('Loading model:', modelPath);

        const gltf = await new Promise((resolve, reject) => {
            gltfLoader.load(
                modelPath,
                resolve,
                (xhr) => {
                    const percent = (xhr.loaded / xhr.total * 100).toFixed(0);
                    console.log('Loading progress:', percent + '%');
                    loadingDiv.textContent = `Loading 3D Model... ${percent}%`;
                },
                reject
            );
        });

        // Cache the loaded model
        modelCache.set(modelFile, gltf.scene.clone());

        // Update scene with the loaded model
        updateScene(gltf.scene);

        // Remove loading message
        loadingDiv.remove();

        // Hide empty state if it exists
        const emptyState = container.querySelector('.empty-state');
        if (emptyState) {
            emptyState.style.display = 'none';
        }

    } catch (error) {
        console.error('Error loading model:', error);
        console.error('Failed to load:', modelFile);

        const loadingDiv = container.querySelector('.loading-model');
        if (loadingDiv) {
            loadingDiv.textContent = 'Error loading 3D model. Please try again.';
        }

        // Attempt to load default model if the requested one fails
        if (modelFile !== '3D Basic T-shirt.glb') {
            console.log('Attempting to load default model...');
            loadModel('3D Basic T-shirt.glb');
        }
    }
}

function updateScene(newModel) {
    if (currentModel) {
        scene.remove(currentModel);
        disposeModel(currentModel);
    }

    currentModel = newModel;
    let foundPaintMesh = null;
    let foundPaintMeshScore = -1;

    // Enhance material settings for visibility against black
    currentModel.traverse((node) => {
        if (node.isMesh) {
            const name = (node.name || '').toLowerCase();
            const vertexCount = node.geometry && node.geometry.attributes.position ? node.geometry.attributes.position.count : 0;
            console.log('Mesh:', name, 'Vertex count:', vertexCount);
            node.castShadow = true;
            node.receiveShadow = true;
            if (node.material) {
                node.material.needsUpdate = true;
                node.material.side = THREE.DoubleSide;
                node.material.roughness = 0.5;
                node.material.metalness = 0.2;
                node.material.envMapIntensity = 1.5;
                console.log('Material set/updated for mesh:', node.name || node.id);
            }
            // Prefer meshes with 'shirt', 'body', or 'front' in the name
            let score = 0;
            if (name.includes('shirt') || name.includes('body') || name.includes('front')) score += 10000;
            score += vertexCount;
            if (score > foundPaintMeshScore) {
                foundPaintMesh = node;
                foundPaintMeshScore = score;
            }
        }
    });

    // Position model at exact center BEFORE painting setup
    const box = new THREE.Box3().setFromObject(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    currentModel.position.set(0, 0, 0);
    currentModel.updateMatrixWorld(true);
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetSize = 2.5; // Slightly larger for visibility
    const scale = targetSize / maxDim;
    currentModel.scale.setScalar(scale);
    // Ensure model is exactly centered
    currentModel.position.copy(center).multiplyScalar(-scale);

    // Collect all mesh candidates with UVs
    paintMeshCandidates = [];
    currentModel.traverse((node) => {
        if (node.isMesh && node.geometry && node.geometry.attributes.uv) {
            paintMeshCandidates.push(node);
        }
    });
    paintMeshCandidateIndex = 0;
    // Use the first candidate by default
    if (paintMeshCandidates.length > 0) {
        paintMesh = paintMeshCandidates[paintMeshCandidateIndex];
        highlightPaintMesh(paintMesh);
        setupPaintTexture(paintMesh);
        // Log world position and scale
        paintMesh.updateMatrixWorld(true);
        const worldPos = new THREE.Vector3();
        paintMesh.getWorldPosition(worldPos);
        const worldScale = new THREE.Vector3();
        paintMesh.getWorldScale(worldScale);
        console.log('Paint mesh world position:', worldPos, 'world scale:', worldScale);
        console.log('Selected paint mesh:', paintMesh.name, 'Index:', paintMeshCandidateIndex, '/', paintMeshCandidates.length);
    } else {
        paintMesh = null;
        console.warn('No mesh with UVs found for painting.');
    }

    scene.add(currentModel);

    // Reset camera to safe position
    camera.position.set(0, 1, 5);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();

    renderer.render(scene, camera);
}

// Color management
let currentBackgroundColor = new THREE.Color(0xE5E5E5);
let baseHSL = { h: 0, s: 0, l: 0 };
let currentGarmentColor = new THREE.Color(0xE5E5E5);

// Update garment color function
function updateGarmentColor(color) {
    try {
        currentGarmentColor.set(color);
        // Update all materials in the model
        if (currentModel) {
            currentModel.traverse((node) => {
                if (node.isMesh && node.material) {
                    // If no painting, remove the texture so color is fully visible
                    if (!hasPainting) {
                        if (Array.isArray(node.material)) {
                            node.material.forEach(mat => {
                                mat.map = null;
                                mat.color = currentGarmentColor.clone();
                                mat.needsUpdate = true;
                            });
                        } else {
                            node.material.map = null;
                            node.material.color = currentGarmentColor.clone();
                            node.material.needsUpdate = true;
                        }
                    } else {
                        // If painting exists, keep the texture and tint with color
                        if (Array.isArray(node.material)) {
                            node.material.forEach(mat => {
                                mat.color = currentGarmentColor.clone();
                                mat.needsUpdate = true;
                            });
                        } else {
                            node.material.color = currentGarmentColor.clone();
                            node.material.needsUpdate = true;
                        }
                    }
                }
            });
        }
        console.log('Garment color updated:', color);
    } catch (error) {
        console.error('Error updating garment color:', error);
    }
}

// Update background color function
function updateBackgroundColor(color) {
    try {
        currentBackgroundColor.set(color);
        // Store the HSL values of the selected color
        currentBackgroundColor.getHSL(baseHSL);
        console.log('Background color updated:', color);
    } catch (error) {
        console.error('Error updating background color:', error);
    }
}

function animate() {
    requestAnimationFrame(animate);

    if (controls) {
        controls.update();
    }

    if (currentModel) {
        if (autoRotate) {
            currentModel.rotation.y += 0.005;
        }

        // Calculate lightness adjustment based on rotation
        const rotationY = currentModel.rotation.y;
        // Create a smooth oscillation between -0.3 and 0.3
        const lightnessAdjustment = Math.sin(rotationY) * 0.3;

        // Create new color with adjusted lightness
        const adjustedColor = new THREE.Color();
        adjustedColor.setHSL(
            baseHSL.h,
            baseHSL.s,
            Math.max(0, Math.min(1, baseHSL.l + lightnessAdjustment)) // Clamp between 0 and 1
        );

        // Apply the adjusted color
        scene.background = adjustedColor;
    }

    renderer.render(scene, camera);
}

// Listen for color updates
window.addEventListener('updateSceneBackground', (event) => {
    if (event.detail && event.detail.color) {
        const color = event.detail.color;
        console.log('Received background color update:', color);
        updateBackgroundColor(color);
    }
});

window.addEventListener('updateGarmentColor', (event) => {
    if (event.detail && event.detail.color) {
        const color = event.detail.color;
        console.log('Received garment color update:', color);
        updateGarmentColor(color);
    }
});

function onWindowResize() {
    const container = document.getElementById('three-container');
    if (!container || !camera || !renderer) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
}

// Clean up function to prevent memory leaks
function cleanup() {
    // Dispose of all cached models
    modelCache.forEach((model) => {
        disposeModel(model);
    });
    modelCache.clear();

    // Dispose current model
    if (currentModel) {
        disposeModel(currentModel);
    }

    // Dispose of renderer
    if (renderer) {
        renderer.dispose();
    }

    // Remove event listeners
    window.removeEventListener('resize', onWindowResize);

    // Dispose of controls
    if (controls) {
        controls.dispose();
    }
}

// Export cleanup function
export { init, cleanup };

// Export scene for external access
export { scene, camera, renderer };

// Add this at the end of the file to allow toggling auto-rotation from the window
window.setAutoRotate = function (val) { autoRotate = val; };

// Expose enable3DPainting for UI integration
window.enable3DPainting = enable3DPainting;

// Export painted shirt texture as image
window.exportPaintedTexture = function () {
    if (window.paintCanvas) {
        const link = document.createElement('a');
        link.href = window.paintCanvas.toDataURL('image/png');
        link.download = 'painted-shirt.png';
        link.click();
    } else {
        alert('No painted texture to export!');
    }
};

// Inpainting mode toggle and color
let inpaintingMode = false;
let inpaintingColor = 'rgba(255,0,0,0.7)'; // Red for inpainting

// Call this function to enable/disable inpainting mode
window.setInpaintingMode = function (enable) {
    inpaintingMode = enable;
    if (inpaintingMode) {
        paintingColor = inpaintingColor;
        // Enable 3D painting/masking when inpainting mode is enabled
        if (typeof enable3DPainting === 'function') {
            enable3DPainting(true);
        }
    } else {
        // Set back to default brush color (or allow user to pick)
        paintingColor = 'rgba(99,102,241,0.7)';
        // Disable 3D painting/masking when inpainting mode is disabled
        if (typeof enable3DPainting === 'function') {
            enable3DPainting(false);
        }
    }
};

// Export inpainting mask as black/white PNG
window.exportInpaintingMask = function () {
    if (window.maskCanvas) {
        const link = document.createElement('a');
        link.href = window.maskCanvas.toDataURL('image/png');
        link.download = 'inpainting-mask.png';
        link.click();
    } else {
        alert('No inpainting mask to export!');
    }
};

// Optionally, add a function to clear painting
window.clearPainting = function () {
    hasPainting = false;
    if (paintMesh && paintMesh.material) {
        if (Array.isArray(paintMesh.material)) {
            paintMesh.material.forEach(mat => {
                mat.map = null;
                mat.needsUpdate = true;
            });
        } else {
            paintMesh.material.map = null;
            paintMesh.material.needsUpdate = true;
        }
    }
    if (paintCtx && paintCanvas) {
        paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    }
    if (maskCtx && maskCanvas) {
        maskCtx.fillStyle = 'rgb(0,0,0)';
        maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
    if (typeof updateGarmentColor === 'function') {
        updateGarmentColor(currentGarmentColor.getStyle ? currentGarmentColor.getStyle() : currentGarmentColor);
    }
};

function highlightPaintMesh(mesh) {
    // Assign unique colors to each candidate for debugging
    const debugColors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#888888'];
    paintMeshCandidates.forEach((m, i) => {
        if (m.material) {
            // Force visible and opaque
            m.visible = true;
            m.material.visible = true;
            m.material.opacity = 1;
            m.material.transparent = false;
            m.material.wireframe = true; // Show wireframe for debugging
            // Assign unique color
            if (m.material.color) {
                m.material.color.set(debugColors[i % debugColors.length]);
            }
            // Log material type
            console.log('Candidate mesh:', m.name, 'Material type:', m.material.type, m.material);
        }
    });
    // Highlight the selected mesh in green (overrides unique color)
    if (mesh && mesh.material && mesh.material.color) {
        mesh.material.color.set('#00ff00');
    }
}

// Add keyboard shortcut to cycle paint mesh
window.addEventListener('keydown', function (e) {
    if (e.key === 'n' || e.key === 'N') {
        if (paintMeshCandidates.length > 1) {
            paintMeshCandidateIndex = (paintMeshCandidateIndex + 1) % paintMeshCandidates.length;
            paintMesh = paintMeshCandidates[paintMeshCandidateIndex];
            highlightPaintMesh(paintMesh);
            setupPaintTexture(paintMesh);
            console.log('Cycled to paint mesh:', paintMesh.name, 'Index:', paintMeshCandidateIndex, '/', paintMeshCandidates.length);
        }
    }
}); 