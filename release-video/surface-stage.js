/** Render the actual DTU Scan 65 mesh using the camera curated for the paper's surface viewer. */
export async function createSurfaceStage(container, { width = 936, height = 486 } = {}) {
  const base = "https://cdn.jsdelivr.net/npm/three@0.185.1";
  const [THREE, { GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import(`${base}/+esm`),
    import(`${base}/examples/jsm/loaders/GLTFLoader.js/+esm`),
    import(`${base}/examples/jsm/loaders/DRACOLoader.js/+esm`),
  ]);
  const manifest = await fetch("../static/data/surface_vis.json").then((response) => response.json());
  const scan = manifest.datasets.find((dataset) => dataset.id === "dtu").scenes.find((scene) => scene.id === "scan65");
  const decoder = new DRACOLoader().setDecoderPath(`${base}/examples/jsm/libs/draco/gltf/`);
  const model = await new GLTFLoader().setDRACOLoader(decoder).loadAsync("assets/skull.glb");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(width, height); renderer.setClearColor(0xffffff, 0);
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ color: 0xcac3b7, roughness: 0.92, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  model.scene.traverse((node) => { if (node.isMesh) node.material = material; });
  scene.add(model.scene, new THREE.HemisphereLight(0xffffff, 0x6e6258, 2.5));
  const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(2, 5, 4); scene.add(key);
  const camera = new THREE.PerspectiveCamera(scan.camera.fov, width / height, 0.1, 10000);
  const target = new THREE.Vector3(...scan.camera.target);
  const up = new THREE.Vector3(...scan.camera.up).normalize();
  const offset = new THREE.Vector3(...scan.camera.position).sub(target).multiplyScalar(0.84);
  camera.up.copy(up);
  function render(seconds) {
    camera.position.copy(offset).applyAxisAngle(up, Math.sin(seconds * 0.65) * 0.2).add(target);
    camera.lookAt(target); renderer.render(scene, camera);
  }
  render(0);
  return { render };
}
