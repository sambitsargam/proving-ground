import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// Token values, since WebGL materials cannot read CSS variables.
const COBALT = "#2F5BFF";
const LIME = "#C6FF1A";
const THREAT = "#FF3D6E";
const PARTICLES = 18;
const SPAWN_RADIUS = 6;
const HIT_RADIUS = 1.35;

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
}

function spawn(): Particle {
  const direction = new THREE.Vector3(
    Math.random() - 0.5,
    Math.random() - 0.5,
    Math.random() - 0.5,
  ).normalize();
  const position = direction.clone().multiplyScalar(SPAWN_RADIUS);
  return { position, velocity: direction.multiplyScalar(-(1.2 + Math.random() * 1.4)), life: 1 };
}

/** Red attack particles fly at the vault and dissolve on contact. */
function Attacks() {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const particles = useMemo(() => Array.from({ length: PARTICLES }, spawn), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, delta) => {
    const step = Math.min(delta, 0.05);
    particles.forEach((particle, index) => {
      if (particle.position.length() > HIT_RADIUS) {
        particle.position.addScaledVector(particle.velocity, step);
      } else {
        particle.life -= step * 4;
        if (particle.life <= 0) particles[index] = spawn();
      }
      const current = particles[index] as Particle;
      dummy.position.copy(current.position);
      dummy.scale.setScalar(0.05 * Math.max(current.life, 0));
      dummy.updateMatrix();
      mesh.current?.setMatrixAt(index, dummy.matrix);
    });
    if (mesh.current) mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, PARTICLES]}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial color={THREAT} toneMapped={false} />
    </instancedMesh>
  );
}

/** The cube's 12 edges as thin rods. WebGL draws lines 1px wide whatever you ask for. */
function edgeRods(): { position: THREE.Vector3; quaternion: THREE.Quaternion; length: number }[] {
  const points = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)).attributes.position;
  if (!points) return [];
  const rods = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < points.count; i += 2) {
    const a = new THREE.Vector3().fromBufferAttribute(points, i);
    const b = new THREE.Vector3().fromBufferAttribute(points, i + 1);
    const direction = b.clone().sub(a);
    rods.push({
      position: a.clone().add(b).multiplyScalar(0.5),
      quaternion: new THREE.Quaternion().setFromUnitVectors(up, direction.clone().normalize()),
      length: direction.length(),
    });
  }
  return rods;
}

function Vault({ still }: { still: boolean }) {
  const group = useRef<THREE.Group>(null);
  const rods = useMemo(edgeRods, []);
  useFrame((state, delta) => {
    if (!group.current || still) return;
    // Slow idle turn, leaning a little toward the cursor.
    const target = state.pointer;
    group.current.rotation.y += delta * 0.18;
    group.current.rotation.x += (target.y * 0.25 - group.current.rotation.x) * 0.04;
    group.current.position.x += (target.x * 0.15 - group.current.position.x) * 0.04;
  });
  return (
    <group ref={group} rotation={[0.45, 0.65, 0]}>
      <mesh>
        <boxGeometry args={[1.98, 1.98, 1.98]} />
        <meshPhysicalMaterial
          color="#11141D"
          metalness={0.2}
          roughness={0.3}
          clearcoat={1}
          clearcoatRoughness={0.15}
        />
      </mesh>
      {rods.map((rod) => (
        <mesh
          key={rod.position.toArray().join()}
          position={rod.position}
          quaternion={rod.quaternion}
        >
          <cylinderGeometry args={[0.022, 0.022, rod.length + 0.044, 8]} />
          <meshBasicMaterial color={COBALT} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, 0, 1.01]}>
        <torusGeometry args={[0.42, 0.045, 16, 64]} />
        <meshBasicMaterial color={LIME} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 1.01]}>
        <circleGeometry args={[0.12, 32]} />
        <meshBasicMaterial color={LIME} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** The hero vault. `still` freezes it, for reduced motion and for rendering the poster. */
export default function VaultScene({ still = false }: { still?: boolean }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 6.2], fov: 40 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: still }}
      aria-hidden="true"
    >
      <ambientLight intensity={0.35} />
      <directionalLight position={[4, 5, 3]} intensity={1.6} color="#F2F4F8" />
      <directionalLight position={[-5, -1, 2]} intensity={2.2} color={COBALT} />
      <directionalLight position={[0, -4, -3]} intensity={1.2} color={COBALT} />
      <Vault still={still} />
      {!still && <Attacks />}
    </Canvas>
  );
}
