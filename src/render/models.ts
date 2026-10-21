// Placeholder monsters built from primitives. Each faces +z. Swap for glTF
// later: keep the same contract (a Group facing +z, feet at y=0, optional
// children named 'body', 'wingL', 'wingR' for idle animation).

import * as THREE from 'three';

const NANITE = 0x5ff3ff;

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, flatShading: true, ...opts });
}
const glow = () => mat(NANITE, { emissive: NANITE, emissiveIntensity: 1.2, roughness: 0.3 });

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  return o;
}

export function buildMonsterModel(id: string, color: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Group();
  body.name = 'body';
  g.add(body);
  const skin = mat(color);
  const dark = mat(new THREE.Color(color).multiplyScalar(0.55).getHex());

  switch (id) {
    case 'rhino': {
      body.add(mesh(new THREE.BoxGeometry(0.75, 0.55, 1.05), skin, 0, 0.5, 0));
      body.add(mesh(new THREE.BoxGeometry(0.5, 0.42, 0.4), skin, 0, 0.55, 0.65));
      const horn = mesh(new THREE.ConeGeometry(0.09, 0.38, 5), glow(), 0, 0.82, 0.78);
      horn.rotation.x = 0.5;
      body.add(horn);
      // Nanite plates along the spine.
      for (let i = 0; i < 3; i++) body.add(mesh(new THREE.BoxGeometry(0.5, 0.08, 0.22), glow(), 0, 0.8, -0.3 + i * 0.28));
      for (const [x, z] of [[-0.25, 0.35], [0.25, 0.35], [-0.25, -0.35], [0.25, -0.35]]) {
        g.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.25, 6), dark, x, 0.12, z));
      }
      break;
    }
    case 'fox': {
      body.add(mesh(new THREE.BoxGeometry(0.36, 0.34, 0.8), skin, 0, 0.45, 0));
      const head = mesh(new THREE.ConeGeometry(0.2, 0.45, 4), skin, 0, 0.55, 0.55);
      head.rotation.x = Math.PI / 2;
      body.add(head);
      for (const x of [-0.11, 0.11]) body.add(mesh(new THREE.ConeGeometry(0.06, 0.2, 4), dark, x, 0.78, 0.42));
      const tail = mesh(new THREE.ConeGeometry(0.13, 0.6, 5), glow(), 0, 0.55, -0.6);
      tail.rotation.x = -Math.PI / 2.6;
      body.add(tail);
      for (const [x, z] of [[-0.12, 0.28], [0.12, 0.28], [-0.12, -0.28], [0.12, -0.28]]) {
        g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 5), dark, x, 0.15, z));
      }
      break;
    }
    case 'moth': {
      body.position.y = 0.55;
      body.add(mesh(new THREE.CapsuleGeometry(0.13, 0.4, 3, 8), skin, 0, 0, 0));
      body.children[0].rotation.x = Math.PI / 2;
      const wingMat = mat(color, { emissive: NANITE, emissiveIntensity: 0.35, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
      for (const side of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.name = side < 0 ? 'wingL' : 'wingR';
        const wing = mesh(new THREE.CircleGeometry(0.42, 5), wingMat, side * 0.4, 0, 0);
        wing.rotation.x = -Math.PI / 2;
        pivot.add(wing);
        body.add(pivot);
      }
      for (const x of [-0.07, 0.07]) {
        const ant = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4), glow(), x, 0.12, 0.32);
        ant.rotation.x = 0.8;
        body.add(ant);
      }
      g.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4), glow(), 0, 0.2, 0));
      break;
    }
    case 'porcupine': {
      const core = mesh(new THREE.IcosahedronGeometry(0.38, 0), skin, 0, 0.42, 0);
      core.scale.set(1, 0.85, 1.2);
      body.add(core);
      const ico = new THREE.IcosahedronGeometry(0.4, 0).getAttribute('position');
      const quill = new THREE.ConeGeometry(0.04, 0.35, 4);
      quill.translate(0, 0.17, 0);
      const seen = new Set<string>();
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < ico.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(ico, i);
        const k = v.toArray().map((n) => n.toFixed(2)).join();
        if (seen.has(k) || v.y < -0.1 || v.z > 0.3) continue;
        seen.add(k);
        const q = mesh(quill, i % 2 ? glow() : dark, v.x, 0.42 + v.y * 0.85, v.z * 1.2);
        q.quaternion.setFromUnitVectors(up, v.clone().normalize());
        body.add(q);
      }
      const snout = mesh(new THREE.SphereGeometry(0.14, 6, 5), dark, 0, 0.35, 0.45);
      body.add(snout);
      break;
    }
    case 'eel': {
      body.position.y = 0.6;
      const seg = new THREE.SphereGeometry(0.17, 8, 6);
      for (let i = 0; i < 5; i++) {
        const s = mesh(seg, i === 0 ? skin : i % 2 ? dark : skin, Math.sin(i * 1.1) * 0.12, Math.cos(i * 0.9) * 0.05, 0.4 - i * 0.22);
        s.scale.setScalar(1 - i * 0.12);
        body.add(s);
      }
      const halo = mesh(new THREE.TorusGeometry(0.42, 0.03, 6, 20), glow(), 0, -0.3, 0);
      halo.rotation.x = Math.PI / 2;
      g.add(halo);
      for (const x of [-0.08, 0.08]) body.add(mesh(new THREE.SphereGeometry(0.035, 5, 4), glow(), x, 0.08, 0.53));
      break;
    }
    case 'lynx': {
      body.add(mesh(new THREE.BoxGeometry(0.42, 0.38, 0.85), skin, 0, 0.5, 0));
      body.add(mesh(new THREE.BoxGeometry(0.36, 0.32, 0.32), skin, 0, 0.66, 0.52));
      for (const x of [-0.12, 0.12]) {
        body.add(mesh(new THREE.ConeGeometry(0.05, 0.22, 4), dark, x, 0.92, 0.5));
        body.add(mesh(new THREE.SphereGeometry(0.04, 5, 4), glow(), x * 0.8, 0.7, 0.69));
      }
      body.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.25), glow(), 0, 0.6, -0.52));
      for (const [x, z] of [[-0.14, 0.3], [0.14, 0.3], [-0.14, -0.3], [0.14, -0.3]]) {
        g.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.32, 5), dark, x, 0.16, z));
      }
      break;
    }
    case 'octopus': {
      body.add(mesh(new THREE.SphereGeometry(0.34, 8, 6), skin, 0, 0.72, -0.05));
      body.children[0].scale.set(1, 1.15, 1.1);
      for (const x of [-0.13, 0.13]) body.add(mesh(new THREE.SphereGeometry(0.06, 6, 4), glow(), x, 0.72, 0.28));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const arm = mesh(new THREE.ConeGeometry(0.07, 0.6, 5), i % 2 ? skin : dark, Math.sin(a) * 0.28, 0.25, Math.cos(a) * 0.28);
        arm.rotation.set(Math.cos(a) * 0.7, 0, -Math.sin(a) * 0.7);
        arm.rotateX(Math.PI);
        g.add(arm);
      }
      break;
    }
    default:
      body.add(mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), skin, 0, 0.4, 0));
  }
  return g;
}
