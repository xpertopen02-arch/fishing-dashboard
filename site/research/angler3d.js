// v2.3.16 추천 자리(1~3위)에서 낚시하는 사람: 루어 낚싯대(스피닝 릴)로 캐스팅, 잡기 좋은 송어 층에 맞춰 감기,
// 활성 송어의 추격과 입질, 입에 바늘이 걸린 채 파이팅, 뜰채 랜딩.
// 덕봉·한터·장광 3D가 같이 씁니다. 각 페이지는 Angler3D.create(...)로 만들고 추천이 바뀔 때 setSpots, 매 프레임 update를 부릅니다.
// 크기는 송어 그림과 맞춰 실제보다 크게 그립니다 (사람 약 1.8배, 송어 그림은 원래 페이지 그대로).
(function () {
  "use strict";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (u) => (u < .5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));
  const lerp = (a, b, t) => a + (b - a) * t;

  // 동작 시간(초)과 확률. 관리형 송어터 루어 낚시 흐름: 던지고, 송어가 있는 층까지 가라앉힌 뒤 일정하게 감고,
  // 송어가 따라오다 물면 챔질, 대를 세워 버티며 끌어오고, 발 앞에서 뜰채를 물속에 넣어 머리부터 담아 올립니다.
  const T = { ready: .7, back: .38, fwd: .24, lift: .55, hook: .35, land: 1.3, raise: 1.1, show: 1.4, lost: 1.1, idleCaught: 45 };
  const K = 1.8;                 // 사람 크기 배율
  const SINK = .9;               // 스푼이 가라앉는 속도(m/초, 보기 좋게 빠르게)
  const LAYER_R = 9;             // 이 거리 안의 활성 송어 깊이에 맞춰 감는 층을 고칩니다(m)
  const CHASE_R = 7;             // 이 거리 안의 활성 송어가 따라옵니다(m)
  const CHASE_RATE = .45;        // 근처 활성 송어 한 마리당 1초에 따라올 확률 (같은 층일수록 높음)
  const BITE_P = .3;             // 따라온 송어가 무는 확률 기본값 (페이지의 '잡히는 확률'로 바꿈)
  const LOST_P = .12;            // 파이팅 중 빠지는 확률
  const COLORS = [0xe8731c, 0x1f9e8f, 0xc23b4a];
  const HIP_Y = .92, ROD_L = 1.83, BUTT = .3;   // 엉덩이 높이, 대 길이(6피트 트라우트 대), 손 뒤 손잡이 길이(m)
  const MOUTH = [.97, -.04, 0];  // 송어 그림의 입 (머리 끝이 +x 1)

  function create(o) {
    const { THREE, scene } = o;
    const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
    const root = new THREE.Group(); root.name = "anglers"; scene.add(root);
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    const shiny = (c) => new THREE.MeshPhongMaterial({ color: c, shininess: 80, specular: 0x666666 });
    const UP = V(0, 1, 0);
    const limb = (r, mat, r2 = r) => new THREE.Mesh(new THREE.CylinderGeometry(r2, r, 1, 8), mat);   // 아래 r, 위 r2
    const setLimb = (m, a, b) => { const d = b.clone().sub(a), L = d.length(); m.position.copy(a).addScaledVector(d, .5); m.scale.set(1, Math.max(.001, L), 1); m.quaternion.setFromUnitVectors(UP, d.normalize()); };
    const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
    // 두 마디(위팔·아래팔, 허벅지·정강이)의 관절 위치: a에서 b까지, 길이 l1·l2, hint 쪽으로 굽힘
    function joint(a, b, l1, l2, hint) {
      const d = b.clone().sub(a), L = clamp(d.length(), .01, l1 + l2 - .001); d.normalize();
      const x = (l1 * l1 - l2 * l2 + L * L) / (2 * L), h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
      const n = hint.clone().addScaledVector(d, -hint.dot(d)).normalize();
      return a.clone().addScaledVector(d, x).addScaledVector(n, h);
    }

    const splashes = [];
    const ringGeo = new THREE.RingGeometry(.5, .75, 24);
    function splash(x, z, big) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .8, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, .06, z); root.add(m);
      const n = big ? 14 : 7, g = new THREE.BufferGeometry(), p = new Float32Array(n * 3), v = [];
      for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, s = (big ? 1.6 : 1) * (.6 + Math.random()); v.push([Math.cos(a) * s, (big ? 4.5 : 3) * (.6 + Math.random() * .6), Math.sin(a) * s]); p.set([x, .1, z], i * 3); }
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      const drops = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: big ? .32 : .24, transparent: true, opacity: .95, depthWrite: false }));
      root.add(drops);
      splashes.push({ m, drops, v, t: 0, big });
    }
    function drawSplashes(dt) {
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i]; s.t += dt;
        const u = s.t / (s.big ? 1.1 : .8), R = (s.big ? 1.2 : .7) + u * (s.big ? 3.2 : 2);
        s.m.scale.set(R, R, 1); s.m.material.opacity = .8 * (1 - u);
        const p = s.drops.geometry.attributes.position;
        for (let k = 0; k < s.v.length; k++) { const v = s.v[k]; p.setXYZ(k, p.getX(k) + v[0] * dt, Math.max(0, p.getY(k) + v[1] * dt), p.getZ(k) + v[2] * dt); v[1] -= 14 * dt; }
        p.needsUpdate = true; s.drops.material.opacity = .95 * (1 - u);
        if (u >= 1) { root.remove(s.m, s.drops); s.m.material.dispose(); s.drops.geometry.dispose(); s.drops.material.dispose(); splashes.splice(i, 1); }
      }
    }
    function tag() {
      const cv = document.createElement("canvas"); cv.width = 320; cv.height = 64;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, depthTest: false }));
      sp.scale.set(2.3, .46, 1); sp.renderOrder = 10;
      let last = null;
      sp.userData.draw = (text, bg) => {
        if (text === last) return; last = text;
        const c = cv.getContext("2d"); c.clearRect(0, 0, 320, 64);
        if (text) { c.font = "700 28px system-ui, sans-serif"; const w = Math.min(312, c.measureText(text).width + 28); c.fillStyle = bg || "rgba(16,22,28,.78)"; c.beginPath(); c.roundRect ? c.roundRect(160 - w / 2, 8, w, 48, 14) : c.rect(160 - w / 2, 8, w, 48); c.fill(); c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, 160, 33); }
        sp.material.map.needsUpdate = true; sp.visible = !!text;
      };
      return sp;
    }

    // ---------- 사람 한 명 (몸 기준: 앞 +x, 위 +y, 오른쪽 +z, 단위 m, 전체를 K배) ----------
    function makeAngler(i) {
      const body = new THREE.Group(); body.scale.setScalar(K);
      const C = { pants: lam(0x3b4452), boot: lam(0x2b2622), jacket: lam(COLORS[i % 3]), vest: lam(0x59614c), pocket: lam(0x4a513f), skin: lam(0xdfae88), cap: lam(0x1f242b), glass: shiny(0x0b0f14), glove: lam(0x2f3338), belt: lam(0x1c1c1c) };
      // 아랫몸: 골반, 다리 두 마디, 장화
      const pelvis = mesh(new THREE.BoxGeometry(.2, .17, .34), C.pants);
      const belt = mesh(new THREE.BoxGeometry(.21, .035, .35), C.belt);
      const thighL = limb(.068, C.pants, .078), thighR = limb(.068, C.pants, .078), shinL = limb(.052, C.pants, .064), shinR = limb(.052, C.pants, .064);
      const kneeL = mesh(new THREE.SphereGeometry(.066, 8, 6), C.pants), kneeR = mesh(new THREE.SphereGeometry(.066, 8, 6), C.pants);
      const bootGeo = new THREE.BoxGeometry(.27, .1, .12), bootL = mesh(bootGeo, C.boot), bootR = mesh(bootGeo, C.boot);
      const cuffGeo = new THREE.CylinderGeometry(.062, .06, .14, 8), cuffL = mesh(cuffGeo, C.boot), cuffR = mesh(cuffGeo, C.boot);
      // 윗몸: 허리를 축으로 기울어집니다.
      const upper = new THREE.Group();
      const torso = mesh(new THREE.CylinderGeometry(.17, .15, .56, 14), C.jacket, 0, .3, 0); torso.scale.set(.72, 1, 1.12);
      const vest = mesh(new THREE.CylinderGeometry(.182, .166, .36, 14), C.vest, 0, .35, 0); vest.scale.set(.76, 1, 1.13);
      const pockets = [[.3, -.08], [.3, .08], [.42, -.08], [.42, .08]].map(([y, z]) => mesh(new THREE.BoxGeometry(.025, .075, .085), C.pocket, .136, y, z));
      const shL = mesh(new THREE.SphereGeometry(.07, 10, 8), C.jacket, 0, .5, -.19), shR = mesh(new THREE.SphereGeometry(.07, 10, 8), C.jacket, 0, .5, .19);
      const neck = mesh(new THREE.CylinderGeometry(.045, .05, .09, 10), C.skin, .005, .6, 0);
      const collar = mesh(new THREE.CylinderGeometry(.075, .095, .06, 12), C.jacket, 0, .575, 0);
      const head = new THREE.Group(); head.position.set(.01, .72, 0);
      const skull = mesh(new THREE.SphereGeometry(.1, 16, 12), C.skin); skull.scale.set(1.05, 1.12, .93);
      const nose = mesh(new THREE.BoxGeometry(.035, .04, .026), C.skin, .102, -.012, 0);
      const glasses = mesh(new THREE.BoxGeometry(.03, .034, .175), C.glass, .088, .022, 0);   // 편광 선글라스
      const earL = mesh(new THREE.SphereGeometry(.022, 8, 6), C.skin, -.005, 0, -.096), earR = mesh(new THREE.SphereGeometry(.022, 8, 6), C.skin, -.005, 0, .096);
      const crown = mesh(new THREE.SphereGeometry(.108, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), C.cap, 0, .035, 0); crown.scale.set(1.04, .95, .96);
      const brim = mesh(new THREE.BoxGeometry(.12, .012, .17), C.cap, .125, .04, 0); brim.rotation.z = -.12;
      head.add(skull, nose, glasses, earL, earR, crown, brim);
      upper.add(torso, vest, ...pockets, shL, shR, neck, collar, head);
      // 팔 두 마디와 장갑 낀 손
      const uArmL = limb(.046, C.jacket, .052), uArmR = limb(.046, C.jacket, .052), fArmL = limb(.036, C.jacket, .044), fArmR = limb(.036, C.jacket, .044);
      const elbowL = mesh(new THREE.SphereGeometry(.046, 8, 6), C.jacket), elbowR = mesh(new THREE.SphereGeometry(.046, 8, 6), C.jacket);
      const handL = mesh(new THREE.SphereGeometry(.042, 8, 6), C.glove), handR = mesh(new THREE.SphereGeometry(.042, 8, 6), C.glove);
      handL.scale.set(1.15, .9, .8); handR.scale.set(1.15, .9, .8);
      // 루어 낚싯대: 코르크 손잡이, 릴 시트, 끝으로 가늘어지는 블랭크, 아래로 달린 가이드
      const rod = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 14 }, () => V())), new THREE.LineBasicMaterial());
      rod.visible = false;   // 점 계산용
      const cork = lam(0xb98d5c), seat = shiny(0x23272d), blank = shiny(0x24303d), guideM = shiny(0xc9cdd2);
      const rodSeg = Array.from({ length: 13 }, (_, k) => (k < 2 ? limb(.017, cork) : k === 2 ? limb(.012, seat) : limb(.0105 - (k - 3) * .00068, blank, .0105 - (k - 2) * .00068)));
      const guides = [4, 6, 8, 10, 12].map((k, j) => ({ k, m: new THREE.Mesh(new THREE.TorusGeometry(.024 - j * .0035, .0035, 5, 12), guideM) }));
      // 스피닝 릴: 대 아래에 매달리고, 스풀은 대와 같은 방향, 손잡이는 왼쪽
      const reel = new THREE.Group();
      const stem = mesh(new THREE.BoxGeometry(.014, .065, .012), seat, 0, -.035, 0);
      const foot = mesh(new THREE.BoxGeometry(.06, .01, .02), seat, 0, -.004, 0);
      const rbody = mesh(new THREE.SphereGeometry(.036, 12, 10), shiny(0x3a3f46), -.005, -.088, 0); rbody.scale.set(1.25, 1, .9);
      const spool = mesh(new THREE.CylinderGeometry(.033, .033, .046, 16), shiny(0xd7dbe0), .05, -.088, 0); spool.rotation.z = Math.PI / 2;
      const bail = mesh(new THREE.TorusGeometry(.037, .0035, 5, 16), guideM, .066, -.088, 0); bail.rotation.y = Math.PI / 2;
      const crank = new THREE.Group(); crank.position.set(-.008, -.088, -.036);
      crank.add(mesh(new THREE.BoxGeometry(.012, .07, .008), seat, 0, -.035, 0), mesh(new THREE.CylinderGeometry(.012, .012, .03, 8), cork, 0, -.07, -.016));
      crank.children[1].rotation.x = Math.PI / 2;
      reel.add(stem, foot, rbody, spool, bail, crank);
      body.add(pelvis, belt, thighL, thighR, shinL, shinR, kneeL, kneeR, bootL, bootR, cuffL, cuffR, upper, uArmL, uArmR, fArmL, fArmR, elbowL, elbowR, handL, handR, rod, reel, ...rodSeg, ...guides.map((g) => g.m));
      root.add(body);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 17 }, () => V())), new THREE.LineBasicMaterial({ color: 0xf4f6f8, transparent: true, opacity: .85 }));
      // 스푼과 바늘: 줄 쪽이 +z, 바늘은 꼬리 쪽
      const lure = new THREE.Group();
      const spoon = mesh(new THREE.SphereGeometry(.2, 12, 8), new THREE.MeshPhongMaterial({ color: 0xff7a1a, shininess: 100, specular: 0xffe0a0 })); spoon.scale.set(.62, .2, 1);
      const hook = mesh(new THREE.TorusGeometry(.07, .014, 5, 10, Math.PI * 1.35), shiny(0x2a2d31), 0, -.03, -.24); hook.rotation.y = Math.PI / 2;
      const ringO = mesh(new THREE.TorusGeometry(.035, .01, 5, 8), shiny(0xc9cdd2), 0, 0, .21);
      lure.add(spoon, hook, ringO);
      const net = new THREE.Group();
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(.95, .06, 6, 24), lam(0x2c3440)); hoop.rotation.x = Math.PI / 2;
      const bag = new THREE.Mesh(new THREE.ConeGeometry(.95, 1.1, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0x8fa3b5, wireframe: true, transparent: true, opacity: .6 }));
      bag.rotation.x = Math.PI; bag.position.y = -.55;
      net.add(hoop, bag);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, 1, 8), lam(0x2c3440));
      const trout = new THREE.Mesh(o.fishGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      const label = tag(), pop = tag();
      root.add(line, lure, net, pole, trout, label, pop);
      return { i, body, upper, pelvis, belt, thighL, thighR, shinL, shinR, kneeL, kneeR, bootL, bootR, cuffL, cuffR, uArmL, uArmR, fArmL, fArmR, elbowL, elbowR, handL, handR,
        rod, rodSeg, guides, reel, crank, line, lure, net, pole, trout, label, pop,
        phase: "ready", t: 0, spot: null, a: .35, yaw: 0, bend: 0, lean: 0, crouch: 0, hand: V(.36, HIP_Y + .18, .17), caught: 0, popT: 0, layer: 1,
        fishK: -1, f: null, chase: null, lureP: V(), from: V(), to: V() };
    }
    const anglers = [0, 1, 2].map(makeAngler);
    const kept = new Map();   // 잡혀서 잠시 보이지 않는 송어 번호 -> 다시 보일 시각
    let now = 0, last = 0;

    // 발판 높이: 위에서 아래로 쏜 선이 시설물(부교, 데크)의 윗면에 닿는 높이. 없으면 null
    const ray = new THREE.Raycaster(), DOWN = V(0, -1, 0);
    let deckMeshes = null;
    function deckTop(x, z) {
      if (!o.deck) return null;
      if (!deckMeshes) { deckMeshes = []; o.deck.traverse((m) => { if (m.isMesh && !m.isSprite && !(m.material && m.material.transparent)) deckMeshes.push(m); }); }
      ray.set(V(x, 30, z), DOWN);
      const h = ray.intersectObjects(deckMeshes, false).find((q) => q.point.y > .35 && q.point.y < 3);
      return h ? h.point.y : null;
    }
    // 위치: 추천 핀 근처(사방 7m 안)의 발판 중 핀 옆 1.6m에 가장 가까운 곳에 서고, 캐스팅 방향으로 발판 끝 0.7m 안쪽까지 나갑니다.
    // 근처에 발판이 없으면(연안) 그 자리에 섭니다.
    function placeAt(A, r) {
      const cast = o.castInfo(), v = o.castVec(r, cast), len = Math.hypot(v[0], v[1]) || 1;
      const dx = v[0] / len, dz = v[1] / len;
      A.dir = [dx, dz]; A.R = cast.R; A.fan = cast.mode === "circle" ? .45 : Math.atan(5 / 2 / cast.R);
      const side = [1.6, -1.6, 3.2][A.i], px = o.wx(r.x), pz = o.wz(r.y), sx = px - dz * side, sz = pz + dx * side;   // 사람마다 핀 옆 다른 자리 (잠깐 같은 자리여도 겹치지 않게)
      let best = null, bd = 1e9;
      for (let gx = -7; gx <= 7; gx += .5) for (let gz = -7; gz <= 7; gz += .5) {
        const x = px + gx, z = pz + gz, d = Math.hypot(x - sx, z - sz);
        if (d < bd && deckTop(x, z) !== null) { bd = d; best = [x, z]; }
      }
      A.base = best || [sx, sz];
      let feet = .45; A.edge = 0;
      if (best) {
        let e = 0; while (e < 14 && deckTop(A.base[0] + dx * (e + .25), A.base[1] + dz * (e + .25)) !== null) e += .25;
        const mv = Math.max(0, e - .7); A.base = [A.base[0] + dx * mv, A.base[1] + dz * mv];
        feet = deckTop(A.base[0], A.base[1]) ?? .45; A.edge = Math.min(.7, e);
      }
      A.feet = feet;
      A.body.position.set(A.base[0], feet, A.base[1]);
      A.body.rotation.y = -Math.atan2(dz, dx);
      A.label.position.set(A.base[0], feet + 2.12 * K, A.base[1]);
      A.pop.position.set(A.base[0], feet + 2.55 * K, A.base[1]);
    }
    // 사람은 셋: 1위 자리만 찾아다니는 사람, 2위 자리만, 3위 자리만. 순위의 자리가 바뀌면 하던 동작(던지기, 파이팅)을
    // 마친 뒤 새 자리로 옮기고, 그날 잡은 마릿수는 이어서 셉니다. 날짜가 바뀌거나 재생이 아침으로 돌아가면 0부터.
    let wanted = [], castKey = "";
    // 그날 마릿수: 모델 시계(10분 칸)마다 그 순위 자리의 기대 조과를 더합니다. 한 시간 30번 던지고, 던진 줄 근처의 활성 송어가
    // 많을수록 따라오며, 따라온 송어는 '잡히는 확률'로 물고, 일부(12%)는 빠집니다. 재생 속도와 상관없이 같은 값이 나옵니다.
    // 지나간 시각으로 되돌리면 그때까지 센 값을 보여 줍니다.
    const CASTS_PER_H = 20, FOLLOW_K = .01, tallies = {};
    const biteNow = () => (o.biteP ? o.biteP() : BITE_P);
    // 추천 순위와 같은 계산: 그 자리 캐스팅 범위 안의 송어 비율(share)과 활성 높은 송어 비율(hiShare)에 총 마릿수를 곱하고,
    // 크기 비율과 루어 운용으로 반응할 송어 수를 정합니다. 작은 송어는 활성 높은 송어가 움직이는 루어에,
    // 큰 송어는 활성 높음·보통 송어가 정적인 루어에 주로 반응합니다. '섞어서'는 두 운용의 평균.
    // 순위는 입질 밀도(score)로 정해지므로, 1위 자리의 수를 기준으로 각 자리의 score 비율만큼 줄입니다 (1위 >= 2위 >= 3위).
    function rateAt(r, top = r) {
      const total = o.total ? o.total() : 600, b = o.bigShare ? o.bigShare() : .3, k = top.score > 0 ? clamp(r.score / top.score, 0, 1) : 1;
      const hi = (top.hiShare || 0) * total * k, mid = Math.max(0, (top.share || 0) - (top.hiShare || 0)) * total * k;
      const eff = { move: (1 - b) * hi + b * .25 * hi, static: (1 - b) * .3 * hi + b * (hi + .6 * mid) };
      const mode = o.lureMode ? o.lureMode() : "mix", N = mode === "mix" ? (eff.move + eff.static) / 2 : eff[mode] || eff.move;
      return CASTS_PER_H * (1 - Math.exp(-FOLLOW_K * N)) * biteNow() * (1 - LOST_P);   // 시간당 마릿수
    }
    // 하루 한 턴: 재생이 19시에서 아침 6시로 돌아가면 새 턴으로 보고 0부터 다시 셉니다 (같은 날짜여도 새로 계산).
    let tallyH = null;
    function tally(day, h) {
      if (tallyH !== null && tallyH >= 18.9 && h <= 6.1) delete tallies[day];
      tallyH = h;
      const tick = Math.round((h - 6) * 6), D = tallies[day] || (tallies[day] = { last: 0, cum: [[0], [0], [0]] });
      if (tick > D.last) {
        anglers.forEach((A, i) => { const r = wanted[i] ? rateAt(wanted[i], wanted[0]) / 6 : 0, c = D.cum[i]; for (let k = D.last + 1; k <= tick; k++) c[k] = (c[k - 1] || 0) + r; });
        D.last = tick;
      }
      anglers.forEach((A, i) => { const c = D.cum[i]; let k = clamp(tick, 0, D.last); while (k > 0 && c[k] === undefined) k--; A.caught = Math.floor(c[k] || 0); A.rate = wanted[i] ? rateAt(wanted[i], wanted[0]) : 0; });
    }
    const keyOf = (r) => r && r.key;
    function setSpots(list, day, h) {
      wanted = list;
      const ck = `${o.castInfo().mode}|${o.castInfo().R}`, recast = ck !== castKey; castKey = ck;
      anglers.forEach((A, i) => {
        const r = wanted[i] || null;
        A.want = r;
        if (!r) return;
        if (!A.key) moveTo(A, r);                                   // 처음: 바로 그 자리에
        else if (keyOf(r) === A.key) { A.spot = r; if (recast) placeAt(A, r); }   // 같은 자리: 최신 값과 캐스팅 범위만 반영
      });
      if (day !== undefined && h !== undefined) tally(day, h);
      relabel();
      showCounts();
    }
    function moveTo(A, r) {
      free(A, true); A.phase = "ready"; A.t = 0; A.showLayer = false;
      A.key = keyOf(r); A.spot = r; placeAt(A, r);
    }
    // 페이지의 수심 아래 칸에 1·2·3위 순으로 오늘 마릿수를 적습니다 ('낚시'를 끄면 비움).
    function showCounts() {
      if (!o.onCount) return;
      o.onCount(o.shown() ? anglers.filter((A) => A.want).map((A) => ({ rank: A.i + 1, n: A.caught, spot: A.want.short || "" })) : []);
    }
    function relabel() {
      anglers.forEach((A) => {
        const parts = [`${A.i + 1}위 자리`, `오늘 ${A.caught}마리`]; if (A.showLayer) parts.push(`${A.layer.toFixed(1)}m층 ${A.style === "static" ? "천천히" : "빠르게"}`);
        A.label.userData.draw(A.spot ? parts.join(" · ") : "", ["rgba(150,80,20,.85)", "rgba(20,110,100,.85)", "rgba(140,40,55,.85)"][A.i]);
      });
    }
    // 순위의 자리가 바뀌었으면(쉬는 때에) 옮깁니다.
    const moved = (A) => A.want && keyOf(A.want) !== A.key;
    const pxOf = (x, z) => [x / o.M + o.CX, z / o.M + o.CY];
    const waterDepth = (x, z) => { const [px, py] = pxOf(x, z); return o.depthPx(px, py) || 0; };
    // 캐스팅 거리 설정(사거리)만큼 던집니다. 그 지점이 물이 아니면 물이 나올 때까지 조금씩 줄입니다.
    function pickTarget(A) {
      const ang = (Math.random() * 2 - 1) * A.fan, c = Math.cos(ang), s = Math.sin(ang);
      const dx = A.dir[0] * c - A.dir[1] * s, dz = A.dir[0] * s + A.dir[1] * c;
      let d = A.R * (.94 + .06 * Math.random());
      while (d > 4 && waterDepth(A.base[0] + dx * d, A.base[1] + dz * d) <= .3) d *= .92;
      return V(A.base[0] + dx * d, 0, A.base[1] + dz * d);
    }
    // 송어 번호 k의 그림을 숨깁니다 (이 사람이 대신 그림).
    const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
    const hide = (k) => { if (k >= 0 && k < o.fish.count) o.fish.setMatrixAt(k, ZERO); };
    function free(A, quiet, keep) {
      if (A.fishK >= 0) {
        const c = o.fishCur[A.fishK];
        if (keep) kept.set(A.fishK, now + T.idleCaught);
        else if (c && A.f) { c.x = A.f.x; c.z = A.f.z; c.dep = Math.max(.25, A.f.dep); c.head = A.f.head; }
      }
      A.fishK = -1; A.f = null; A.chase = null;
      A.trout.visible = false; A.net.visible = false; A.pole.visible = false;
      if (!quiet) A.bend = 0;
    }
    // 송어 크기와 루어 운용에 따른 반응: 작은 송어는 빠르게 감는(움직이는) 루어, 큰 송어는 천천히 감다 멈추는(정적인) 루어.
    // 큰 송어는 덜 활발해도(활성 보통) 정적인 루어에는 반응합니다.
    const bigOf = (k) => (o.fishBig ? o.fishBig(k) : false);
    function appeal(k, g, style) {
      const big = bigOf(k);
      if (big) return (style === "static" ? 1 : .25) * (g.fast ? 1 : .6);
      return g.fast ? (style === "static" ? .3 : 1) : 0;
    }
    // 스푼 근처에서 반응할 송어 (가두리 안, 다른 사람이 잡은 송어 제외): [번호, 거리, 깊이, 반응 가중치]
    function nearActive(p, R, style = "move") {
      const out = [];
      for (let k = o.CAGE_N; k < o.fish.count; k++) {
        const c = o.fishCur[k], g = o.fishTo[k];
        if (!c || !g || g.hidden || kept.has(k) || anglers.some((A) => A.fishK === k)) continue;
        const w = appeal(k, g, style);
        if (!w) continue;
        const d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < R) out.push([k, d, c.dep, w]);
      }
      return out;
    }
    // 감는 층: 근처 활성 송어 깊이의 가중 평균(가까울수록 무겁게). 없으면 지금 층을 유지합니다. 바닥 0.2m 위까지만.
    function layerAt(A, p) {
      const near = nearActive(p, LAYER_R, A.style);
      let w = 0, s = 0; near.forEach(([, d, dep, a]) => { const q = a / (1 + d); w += q; s += q * dep; });
      const floor = Math.max(.3, waterDepth(p.x, p.z) - .2);
      return clamp(w ? s / w : A.layer, .3, floor);
    }

    // 낚싯대: 손잡이 끝(손 뒤 0.3m)에서 시작해 휨(bend)만큼 줄 쪽으로 휘어집니다. 몸 기준 좌표.
    const tmp = V(), tmp2 = V();
    const dirOf = (a, w) => V(Math.cos(a) * Math.cos(w), Math.sin(a), Math.cos(a) * Math.sin(w));
    function rodPoints(A, target) {
      let at = -.35, wt = 0;
      if (target) { tmp.copy(target); A.body.worldToLocal(tmp); tmp.sub(A.hand); at = Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z)); wt = Math.atan2(tmp.z, tmp.x); }
      const pts = A.rod.geometry.attributes.position, n = pts.count, seg = ROD_L / (n - 1);
      let p = A.hand.clone().addScaledVector(dirOf(A.a, A.yaw), -BUTT);
      for (let k = 0; k < n; k++) {
        pts.setXYZ(k, p.x, p.y, p.z);
        const s = k / (n - 1), a = A.a + (at - A.a) * A.bend * s * s, w = A.yaw + (wt - A.yaw) * A.bend * s * s;
        p = p.add(tmp2.copy(dirOf(a, w)).multiplyScalar(seg));
      }
      pts.needsUpdate = true;
      const P = (k) => V(pts.getX(k), pts.getY(k), pts.getZ(k));
      for (let k = 0; k < n - 1; k++) setLimb(A.rodSeg[k], P(k), P(k + 1));
      // 가이드: 대 아래쪽에 달린 고리, 대와 수직
      A.guides.forEach(({ k, m }) => {
        const d = P(k + 1).sub(P(k)).normalize(), down = UP.clone().addScaledVector(d, -UP.dot(d)).normalize().negate();
        m.position.copy(P(k)).addScaledVector(down, .03); m.quaternion.setFromUnitVectors(V(0, 0, 1), d);
      });
      // 릴: 손(릴 시트) 아래에 매답니다.
      const d0 = dirOf(A.a, A.yaw), up0 = UP.clone().addScaledVector(d0, -UP.dot(d0)); if (up0.lengthSq() < 1e-4) up0.set(-1, 0, 0); up0.normalize();
      const z0 = d0.clone().cross(up0);
      A.reel.position.copy(A.hand); A.reel.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(d0, up0, z0));
      return A.body.localToWorld(P(n - 1));
    }
    function drawLine(A, tip, end, sag) {
      const pts = A.line.geometry.attributes.position, n = pts.count;
      for (let k = 0; k < n; k++) { const s = k / (n - 1); pts.setXYZ(k, lerp(tip.x, end.x, s), lerp(tip.y, end.y, s) - sag * 4 * s * (1 - s), lerp(tip.z, end.z, s)); }
      pts.needsUpdate = true; A.line.geometry.computeBoundingSphere();
    }
    function drawTrout(A, f, ve, flop) {
      const y = f.y !== undefined ? f.y : -f.dep * ve;
      A.trout.position.set(f.x, y, f.z); A.trout.scale.setScalar(f.size || 1);
      A.trout.rotation.set(0, -f.head + Math.sin(now * (flop ? 22 : 13)) * (flop ? .45 : .2), (f.pitch || 0) + (flop ? Math.sin(now * 17) * .5 : 0), "YZX");
      A.trout.visible = true; A.trout.updateMatrixWorld();
    }
    const mouthOf = (A) => A.trout.localToWorld(V(...MOUTH));
    function popText(A, text, bg) { A.pop.userData.draw(text, bg); A.popT = now + 1.8; }

    // 자세: 동작마다 손 위치(윗몸 기준), 허리 기울기, 무릎 굽힘을 정하고 부드럽게 따라갑니다.
    const POSE = {
      ready: [[.36, .18, .17], 0, .05], back: [[.2, .5, .2], .1, .08], fwd: [[.44, .3, .18], -.14, .15], fly: [[.4, .2, .17], -.05, .1],
      sink: [[.36, .17, .17], 0, .08], retrieve: [[.36, .16, .17], .02, .12], lift: [[.36, .22, .17], 0, .06],
      hook: [[.3, .36, .14], .22, .3], fight: [[.3, .34, .14], .16, .35], lost: [[.34, .24, .16], .05, .15],
      land: [[.2, .48, .2], -.2, .6], raise: [[.24, .44, .2], .02, .4], show: [[.36, .2, .17], 0, .05],
    };
    const rotZ = (v, a) => V(v.x * Math.cos(a) - v.y * Math.sin(a), v.x * Math.sin(a) + v.y * Math.cos(a), v.z);
    function pose(A, dt, leftTarget) {
      const P = POSE[A.phase] || POSE.ready, k = 1 - Math.exp(-dt * 9);
      const wob = A.phase === "fight" ? .05 * Math.sin(now * 2.3) : 0;
      A.lean = lerp(A.lean, P[1] + wob, k); A.crouch = lerp(A.crouch, P[2], k);
      const hipY = HIP_Y - .08 * A.crouch, hip = V(0, hipY, 0);
      A.upper.position.copy(hip); A.upper.rotation.z = A.lean;
      A.pelvis.position.set(0, hipY - .03, 0); A.belt.position.set(0, hipY + .05, 0);
      const handT = hip.clone().add(rotZ(V(...P[0]), A.lean));
      A.hand.lerp(handT, k);
      // 다리: 왼발을 조금 앞에 둔 자세
      [[A.thighL, A.shinL, A.kneeL, A.bootL, A.cuffL, -1, .1], [A.thighR, A.shinR, A.kneeR, A.bootR, A.cuffR, 1, -.1]].forEach(([th, sh, kn, bt, cf, sd, fx]) => {
        const h = V(0, hipY - .06, .1 * sd), an = V(fx, .1, .15 * sd), kp = joint(h, an, .45, .43, V(1, 0, 0));
        setLimb(th, h, kp); setLimb(sh, kp, an); kn.position.copy(kp);
        bt.position.set(fx + .05, .05, .15 * sd); cf.position.set(fx, .14, .15 * sd);
      });
      // 팔: 오른손은 릴 시트(대), 왼손은 릴 손잡이나 뜰채
      const shR = hip.clone().add(rotZ(V(0, .5, .19), A.lean)), shL = hip.clone().add(rotZ(V(0, .5, -.19), A.lean));
      const arm = (sh, hand, ua, fa, el, hm, sd) => {
        const e = joint(sh, hand, .29, .27, V(-.35, -1, .6 * sd));
        setLimb(ua, sh, e); setLimb(fa, e, hand); el.position.copy(e); hm.position.copy(hand);
      };
      arm(shR, A.hand.clone().add(V(0, -.02, 0)), A.uArmR, A.fArmR, A.elbowR, A.handR, 1);
      arm(shL, leftTarget, A.uArmL, A.fArmL, A.elbowL, A.handL, -1);
    }

    function step(A, dt, ve) {
      if (!A.spot) { A.body.visible = A.line.visible = A.lure.visible = A.label.visible = A.pop.visible = false; return; }
      A.body.visible = true; A.t += dt;
      const ph = A.phase, u = (d) => clamp(A.t / d, 0, 1);
      const fd = A.edge + 1.7, front = V(A.base[0] + A.dir[0] * fd, 0, A.base[1] + A.dir[1] * fd);   // 발판 끝 너머 물
      let target = null, sag = 0, lineOn = true, lureOn = true, onFish = false, netHand = false, reeling = 0;
      const go = (p) => { A.phase = p; A.t = 0; };
      if (ph === "ready" && moved(A)) { moveTo(A, A.want); relabel(); return; }
      if (ph === "ready" && !A.want) { A.spot = null; A.key = null; return; }
      if (ph === "ready") {
        A.a = lerp(A.a, .35, .1); A.yaw = lerp(A.yaw, 0, .1); A.bend = lerp(A.bend, 0, .2); lineOn = lureOn = false;
        if (A.t > T.ready) {
          const m = o.lureMode ? o.lureMode() : "mix";
          A.style = m === "mix" ? (Math.random() < .5 ? "move" : "static") : m;   // 섞어서: 던질 때마다 바꿉니다.
          A.to.copy(pickTarget(A)); go("back");
        }
      } else if (ph === "back") {   // 대를 뒤로 넘깁니다.
        A.a = lerp(.35, 1.95, ease(u(T.back))); A.bend = .15; lineOn = lureOn = false;
        if (A.t > T.back) go("fwd");
      } else if (ph === "fwd") {    // 앞으로 휘둘러 던집니다.
        A.a = lerp(1.95, .55, ease(u(T.fwd))); A.bend = .35; lineOn = lureOn = false;
        if (A.t > T.fwd) { A.from.copy(rodPoints(A, null)); A.flyT = .55 + A.from.distanceTo(A.to) * .035; go("fly"); }
      } else if (ph === "fly") {    // 스푼이 포물선으로 사거리만큼 날아갑니다.
        const s = u(A.flyT), d = A.from.distanceTo(A.to);
        A.lureP.set(lerp(A.from.x, A.to.x, s), lerp(A.from.y, 0, s) + Math.min(14, d * .3) * 4 * s * (1 - s), lerp(A.from.z, A.to.z, s));
        A.a = lerp(.55, .3, s); A.bend = .05; target = A.lureP; sag = .2;
        if (A.t > A.flyT) {
          splash(A.to.x, A.to.z, false);
          A.layer = layerAt(A, A.to); A.showLayer = true; relabel();   // 잡기 좋은 송어가 있는 층까지 가라앉힙니다 (카운트다운).
          go("sink");
        }
      } else if (ph === "sink") {
        A.lureP.y = Math.max(-A.layer * ve, A.lureP.y - SINK * ve * dt);
        A.a = lerp(A.a, .18, .1); A.bend = .06; target = A.lureP; sag = .6;
        if (A.lureP.y <= -A.layer * ve + 1e-3) go("retrieve");
      } else if (ph === "retrieve") {   // 일정하게 감으며, 근처 활성 송어 층을 따라 깊이를 고칩니다. 발 앞에서는 떠오릅니다.
        const dx = front.x - A.lureP.x, dz = front.z - A.lureP.z, d = Math.hypot(dx, dz);
        // 빠르게 감기: 일정하게 2.6m/초. 천천히·멈춤: 1.1m/초로 2.2초 감고 1초 멈춤 (멈추면 스푼이 살짝 가라앉으며 팔랑입니다)
        const slow = A.style === "static", cyc = (A.t % 3.2), stop = slow && cyc > 2.2;
        const sp = (slow ? 1.1 : 2.6) * dt * (A.chase ? .8 : 1) * (stop ? 0 : 1);
        A.lureP.x += dx / (d || 1) * Math.min(d, sp); A.lureP.z += dz / (d || 1) * Math.min(d, sp);
        A.layerT = (A.layerT || 0) + dt;
        if (A.layerT > .4) { A.layerT = 0; const L = layerAt(A, A.lureP); if (Math.abs(L - A.layer) > .05) { A.layer = lerp(A.layer, L, .5); relabel(); } }
        const want = A.layer * clamp(d / 4, .2, 1) + (stop ? .25 * (cyc - 2.2) : 0);
        A.lureP.y = lerp(A.lureP.y, -want * ve, 1 - Math.exp(-dt * 2.5));
        A.a = lerp(A.a, stop ? .22 : .15, .08) + (stop ? 0 : Math.sin(now * 9) * .015); A.yaw = lerp(A.yaw, 0, .1); A.bend = .08; target = A.lureP; sag = stop ? .4 : .15; reeling = stop ? 0 : slow ? 6 : 15;
        const lureDep = -A.lureP.y / ve;
        if (!A.chase) {
          const near = nearActive(A.lureP, CHASE_R, A.style);
          const pull = near.reduce((s, [, , dep, w]) => s + w * Math.exp(-Math.abs(dep - lureDep) / .8), 0);   // 같은 층, 맞는 운용일수록 잘 따라옵니다.
          if (near.length && Math.random() < 1 - Math.exp(-CHASE_RATE * pull * dt)) {
            let q = Math.random() * near.reduce((s, x) => s + x[3], 0), pick = near[0];
            for (const x of near) { q -= x[3]; if (q <= 0) { pick = x; break; } }
            const c = o.fishCur[pick[0]], big = bigOf(pick[0]);
            A.fishK = pick[0]; A.f = { x: c.x, z: c.z, dep: c.dep, head: c.head, big, size: big ? 1.4 : .8 }; A.chase = { t: 0, close: 0, bite: Math.random() < (o.biteP ? o.biteP() : BITE_P), lim: .5 + Math.random() };
          }
        }
        if (A.chase) {   // 스푼 뒤 1.2m로 따라붙습니다.
          const f = A.f, C = A.chase; C.t += dt;
          const bx = A.lureP.x - dx / (d || 1) * 1.2, bz = A.lureP.z - dz / (d || 1) * 1.2, ex = bx - f.x, ez = bz - f.z, e = Math.hypot(ex, ez);
          if (C.awayHead === undefined) {
            const v = Math.min(e, (f.big ? 2.6 : 5) * dt); f.x += ex / (e || 1) * v; f.z += ez / (e || 1) * v;
            f.dep = lerp(f.dep, lureDep, .06); f.head = Math.atan2(A.lureP.z - f.z, A.lureP.x - f.x);
          }
          hide(A.fishK); drawTrout(A, f, ve, false);
          if (e < 1.6) C.close += dt;
          if (C.close > C.lim) {
            if (C.bite) { splash(A.lureP.x, A.lureP.z, false); go("hook"); }
            else {   // 보기만 하고 돌아섭니다.
              if (C.awayHead === undefined) { C.awayHead = Math.atan2(f.z - A.lureP.z, f.x - A.lureP.x) + (Math.random() - .5); C.away = 0; }
              C.away += dt; f.head = C.awayHead; f.x += Math.cos(f.head) * 3.5 * dt; f.z += Math.sin(f.head) * 3.5 * dt;
              if (C.away > 1.4) free(A, true);
            }
          } else if (C.t > 6) free(A, true);
        }
        if (A.phase === "retrieve" && d < .3) { A.from.copy(A.lureP); free(A, true); A.showLayer = false; relabel(); go("lift"); }
      } else if (ph === "lift") {   // 입질이 없으면 걷어 올려 다시 던집니다.
        const tip = rodPoints(A, null); A.lureP.lerpVectors(A.from, tip, ease(u(T.lift))); A.a = lerp(A.a, .5, .15); A.bend = 0; target = A.lureP;
        if (A.t > T.lift) go("ready");
      } else if (ph === "hook") {   // 챔질: 대를 세웁니다. 바늘이 송어 입에 걸립니다.
        A.a = lerp(.15, 1.15, ease(u(T.hook))); A.bend = lerp(.1, .7, u(T.hook));
        const f = A.f, tw = Math.atan2(A.base[1] - f.z, A.base[0] - f.x);   // 챔질에 머리가 대 쪽으로 홱 돌아갑니다.
        if (A.t <= dt) A.h0 = f.head;
        const turn = Math.atan2(Math.sin(tw - A.h0), Math.cos(tw - A.h0));
        f.head = A.h0 + turn * ease(u(T.hook)) + Math.sin(now * 20) * .3;
        hide(A.fishK); drawTrout(A, f, ve, true); onFish = true;
        if (A.t > T.hook) {
          A.showLayer = false; relabel();
          const r0 = Math.hypot(f.x - front.x, f.z - front.z);
          A.fight = { r0, dur: (clamp(4.5 + r0 * .22, 5, 10) + Math.random() * 2) * (f.big ? 1.5 : .8), ph: Math.random() * 6, side: Math.random() < .5 ? -1 : 1, lostAt: Math.random() < LOST_P ? .3 + Math.random() * .45 : 2, jumps: [.3 + Math.random() * .15, .62 + Math.random() * .12], ang: Math.atan2(f.z - front.z, f.x - front.x), dep0: f.dep };
          go("fight");
        }
      } else if (ph === "fight") {   // 대를 세우고 버티며 끌어옵니다. 송어는 좌우로 차고, 가끔 수면에서 뜁니다.
        const F = A.fight, p = clamp(A.t / F.dur, 0, 1), f = A.f;
        const run = (f.big ? 3 : 1.6) * Math.max(0, Math.sin(A.t * .9 + F.ph)) * (1 - p);   // 큰 송어는 크게 차고 나갑니다.
        const r = 1.2 + (F.r0 - 1.2) * (1 - ease(p)) + run;
        const lat = F.side * Math.sin(A.t * 1.6 + F.ph) * 2.6 * (1 - .7 * p);
        const ca = Math.cos(F.ang), sa = Math.sin(F.ang);
        const nx = front.x + ca * r - sa * lat, nz = front.z + sa * r + ca * lat;
        // 입에 바늘이 걸려 줄에 끌려오므로 머리(입)가 늘 대 쪽을 향하고, 몸을 좌우로 흔들며 버팁니다.
        // 차고 나갈 때(run)는 몸을 더 크게 틉니다.
        const toward = Math.atan2(A.base[1] - nz, A.base[0] - nx);
        f.head = toward + Math.sin(A.t * 7 + F.ph) * (.28 + .25 * Math.min(1, run)) * (1 - .5 * p);
        f.x = nx; f.z = nz; f.dep = lerp(F.dep0, .05, Math.pow(p, .7)); f.y = undefined; f.pitch = 0;
        for (const j of F.jumps) {   // 수면 위로 뛰며 머리를 털어 냅니다.
          const q = (p - j) / .06;
          if (q >= 0 && q <= 1) { f.y = 1.6 * Math.sin(Math.PI * q); f.pitch = (1 - 2 * q) * .9; if (!F["s" + j]) { F["s" + j] = 1; splash(f.x, f.z, true); } }
          else if (q > 1 && !F["e" + j]) { F["e" + j] = 1; splash(f.x, f.z, true); }
        }
        A.a = 1.05 + .12 * Math.sin(A.t * 2.1); A.bend = (f.big ? .74 : .55) + .2 * Math.max(0, Math.sin(A.t * .9 + F.ph)) * (1 - p);
        reeling = run > .5 ? -5 : 10;   // 차고 나갈 때는 드랙이 풀려 손잡이가 거꾸로 돕니다.
        hide(A.fishK); drawTrout(A, f, ve, f.y > 0); onFish = true;
        if (p >= F.lostAt) { popText(A, "놓쳤다", "rgba(120,60,40,.85)"); A.from.copy(mouthOf(A)); free(A, true); onFish = false; A.lureP.copy(A.from); target = A.lureP; go("lost"); }
        else if (p >= 1) { A.net.position.copy(rodPoints(A, null)); go("land"); }
      } else if (ph === "lost") {   // 바늘이 빠져 대가 펴집니다.
        A.a = lerp(A.a, .4, .12); A.bend = lerp(A.bend, 0, .2);
        const tip = rodPoints(A, null); A.lureP.lerpVectors(A.from, tip, ease(u(T.lost))); target = A.lureP; sag = .4 * (1 - u(T.lost));
        if (A.t > T.lost) go("ready");
      } else if (ph === "land" || ph === "raise") {   // 발 앞에서 뜰채를 물속에 넣고, 송어 머리부터 담아 올립니다.
        const f = A.f, s = ph === "land" ? u(T.land) : u(T.raise);
        const under = V(front.x - A.dir[0] * .6, -.25 * ve, front.z - A.dir[1] * .6);
        const up = V(A.base[0] + A.dir[0] * .9, A.feet + 1.25 * K, A.base[1] + A.dir[1] * .9);
        A.a = lerp(A.a, 1.35, .08); A.bend = .5; A.yaw = lerp(A.yaw, -.3, .08);
        if (ph === "land") {
          A.net.position.lerp(under, .12);
          f.x = lerp(f.x, under.x, s * .12); f.z = lerp(f.z, under.z, s * .12); f.dep = .05; f.y = undefined; f.pitch = 0;
          f.head = Math.atan2(A.base[1] - f.z, A.base[0] - f.x);   // 머리를 뜰채 쪽으로
          if (A.t > T.land) go("raise");
        } else {
          A.net.position.lerpVectors(under, up, ease(s));
          f.x = A.net.position.x; f.z = A.net.position.z; f.y = A.net.position.y - .35; f.pitch = .15;
          if (A.t > T.raise) { popText(A, f.big ? "큰 송어 잡았다!" : "잡았다!", "rgba(20,140,90,.9)"); free(A, true, true); go("show"); }
        }
        if (A.phase === "land" || A.phase === "raise") { netHand = true; hide(A.fishK); drawTrout(A, f, ve, ph === "raise"); onFish = true; }
      } else if (ph === "show") {
        A.a = lerp(A.a, .5, .08); A.bend = lerp(A.bend, 0, .15); A.yaw = lerp(A.yaw, 0, .1); lineOn = lureOn = false;
        if (A.t > T.show) go("ready");
      }
      // 바늘이 걸린 동안 줄 끝과 스푼은 송어 입에 붙습니다.
      if (onFish && A.f) { A.lureP.copy(mouthOf(A)); target = A.lureP; }
      const tip = rodPoints(A, target);
      A.crank.rotation.z -= dt * reeling;
      // 왼손: 감을 때·파이팅 때는 릴 손잡이, 뜰채를 쓸 때는 뜰채 자루, 던질 때는 손잡이 끝
      let left;
      if (netHand) left = V(.3, HIP_Y + .1, -.24).add(rotZ(V(.06, .02, 0), A.lean));
      else if (A.phase === "back" || A.phase === "fwd" || A.phase === "ready" || A.phase === "show") left = A.hand.clone().addScaledVector(dirOf(A.a, A.yaw), -BUTT + .03);
      else { A.crank.updateMatrixWorld(); left = A.body.worldToLocal(A.crank.localToWorld(V(0, -.07, -.03))); }
      pose(A, dt, left);
      if (netHand) {
        A.net.visible = A.pole.visible = true;
        const hl = A.body.localToWorld(left.clone());
        setLimb(A.pole, hl, A.net.position.clone());
      }
      A.line.visible = lineOn && (lureOn || !!target);
      A.lure.visible = lureOn && lineOn;
      if (A.line.visible) drawLine(A, tip, target || A.lureP, sag);
      A.lure.position.copy(A.lureP);
      // 스푼은 줄 쪽(대 끝)을 바라봅니다. 입에 걸리면 입 밖으로 살짝 나옵니다.
      A.lure.lookAt(tip);
      if (onFish) A.lure.position.addScaledVector(tip.clone().sub(A.lureP).normalize(), .12);
      if (!A.f) A.trout.visible = false;
      if (A.popT && now > A.popT) { A.pop.userData.draw(""); A.popT = 0; }
    }

    function update(t) {
      now = t; const dt = Math.min(.1, t - (last || t)); last = t;
      const on = o.shown();
      root.visible = on;
      if (!on) { anglers.forEach((A) => { if (A.fishK >= 0) free(A, true); A.phase = "ready"; A.t = 0; }); return; }
      const ve = o.ve();
      anglers.forEach((A) => step(A, dt, ve));
      kept.forEach((until, k) => {
        if (now < until) { hide(k); return; }
        kept.delete(k); const c = o.fishCur[k], g = o.fishTo[k];
        if (c && g && g.x !== undefined) { c.x = g.x; c.z = g.z; c.dep = g.dep; }   // 시간이 지나면 다른 송어로 다시 보입니다.
      });
      drawSplashes(dt);
      o.fish.instanceMatrix.needsUpdate = true;
    }
    function focus() {
      const A = anglers.find((x) => x.spot); if (!A) return null;   // 1위 자리 사람
      // 사람 뒤 옆에서 사람과 발 앞 물(파이팅·랜딩 자리)이 함께 보이게
      const tgt = V(A.base[0] + A.dir[0] * 3.5, A.feet + 1, A.base[1] + A.dir[1] * 3.5);
      const pos = V(A.base[0] - A.dir[0] * 6.5 - A.dir[1] * 5.5, A.feet + 5.5, A.base[1] - A.dir[1] * 6.5 + A.dir[0] * 5.5);
      return { pos, tgt };
    }
    const stats = () => anglers.map((A) => ({ spot: A.spot && A.spot.short, phase: A.phase, caught: A.caught, fish: A.fishK, rank: A.i, want: A.want && A.want.short, rate: +(A.rate || 0).toFixed(2), edge: A.edge, layer: +A.layer.toFixed(2), lureDep: +(-A.lureP.y / o.ve()).toFixed(2), style: A.style, big: A.f ? A.f.big : null, cast: A.R, thrown: A.to ? +Math.hypot(A.to.x - A.base[0], A.to.z - A.base[1]).toFixed(1) : null }));
    return { setSpots, update, focus, stats, root };
  }
  window.Angler3D = { create };
})();
