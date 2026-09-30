import './office.css';

import { officeFigure } from './office-figures';
import { officeMembers } from './office-members';

type Point = [number, number, number];
type Face = { points: Point[]; material: string; open: boolean };
type DeskPlacement = [distance: number, offset: number, degrees: number];

// A fixed, elevated view into the room. Coordinates are shared by the furniture
// so figures can later be placed at a desk without guessing screen positions.
const pitch = Math.atan2(7.2, 18);

export function project([x, y, z]: Point) {
  const dy = y - 8.5;
  const dz = z - 18;
  const depth = -dy * Math.sin(pitch) - dz * Math.cos(pitch);
  const vertical = dy * Math.cos(pitch) - dz * Math.sin(pitch);
  return {
    x: 700 + (x * 1240) / depth,
    y: 385 - (vertical * 1240) / depth,
    depth,
  };
}

function roomDrawing() {
  let faces: Face[] = [];
  const layers: string[] = [];

  function face(points: Point[], material = 'paper', open = false) {
    faces.push({ points, material, open });
  }

  function line(points: Point[], material = 'detail') {
    face(points, material, true);
  }

  function box(
    [x, y, z]: Point,
    [width, height, depth]: Point,
    material = 'paper',
  ) {
    const a: Point = [x, y, z];
    const b: Point = [x + width, y, z];
    const c: Point = [x + width, y, z + depth];
    const d: Point = [x, y, z + depth];
    const e: Point = [x, y + height, z];
    const f: Point = [x + width, y + height, z];
    const g: Point = [x + width, y + height, z + depth];
    const h: Point = [x, y + height, z + depth];
    face([a, b, f, e], material);
    face([b, c, g, f], material);
    face([c, d, h, g], material);
    face([d, a, e, h], material);
    face([e, f, g, h], material);
  }

  // Flush separate painter layers for the shell, furniture, and desktop objects.
  // Long surfaces such as the floor must sit behind everything resting on them.
  function layer() {
    const projected = faces.map(({ points, material, open }) => ({
      points: points.map(project),
      material,
      open,
    }));
    projected.sort(
      (a, b) =>
        b.points.reduce((sum, point) => sum + point.depth, 0) /
          b.points.length -
        a.points.reduce((sum, point) => sum + point.depth, 0) / a.points.length,
    );
    layers.push(
      projected
        .map(
          ({ points, material, open }) =>
            `<${open ? 'polyline' : 'polygon'} class="office-${material}" points="${points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" />`,
        )
        .join(''),
    );
    faces = [];
  }

  function ring(x: number, y: number, z: number, radius: number): Point[] {
    return Array.from({ length: 16 }, (_, i) => {
      const angle = (i * Math.PI) / 8;
      return [x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius];
    });
  }

  function memberFigure(
    member: (typeof officeMembers)[number],
    armsOnly = false,
  ) {
    const point = project(member.position);
    const scale = 1240 / point.depth;
    layers.push(
      `<g transform="translate(${point.x} ${point.y}) scale(${scale})">${officeFigure(member, armsOnly)}</g>`,
    );
  }

  function pot(x: number, y: number, z: number, size: number) {
    const bottom = ring(x, y, z, size * 0.7);
    const top = ring(x, y + size * 1.2, z, size);
    for (let i = 0; i < top.length; i++) {
      const next = (i + 1) % top.length;
      face([bottom[i], bottom[next], top[next], top[i]], 'plant-pot');
    }
    face(top, 'plant-pot');
    const start: Point = [x, y + size * 1.2, z];
    for (let i = 0; i < 9; i++) {
      const angle = i * 2.4;
      const reach = size * (i % 2 ? 1.65 : 2.2);
      const tip: Point = [
        x + Math.cos(angle) * reach,
        y + size * (i % 3 === 0 ? 4.4 : 3.1),
        z + Math.sin(angle) * reach,
      ];
      const middle: Point = [
        x + Math.cos(angle) * reach * 0.45,
        y + size * 2.9,
        z + Math.sin(angle) * reach * 0.45,
      ];
      const spread = size * 0.42;
      face(
        [
          start,
          [
            middle[0] + Math.sin(angle) * spread,
            middle[1],
            middle[2] - Math.cos(angle) * spread,
          ],
          tip,
          [
            middle[0] - Math.sin(angle) * spread,
            middle[1] - size * 0.25,
            middle[2] + Math.cos(angle) * spread,
          ],
        ],
        'leaf',
      );
      line([start, middle, tip], 'leaf-vein');
    }
  }

  function chair(member: (typeof officeMembers)[number], frontArmOnly = false) {
    const [x, , z] = member.position;
    const side = member.kind === 'human' ? member.side : -1;
    const start = faces.length;
    if (!frontArmOnly) {
      box([x - 0.12, 0.24, z - 0.12], [0.24, 0.73, 0.24], 'metal');
      for (let i = 0; i < 5; i++) {
        const angle = (i * Math.PI * 2) / 5;
        const tip: Point = [
          x + Math.cos(angle) * 0.78,
          0.17,
          z + Math.sin(angle) * 0.78,
        ];
        line([[x, 0.34, z], tip], 'frame');
        const rearRim = ring(0, 0, 0, 0.09).map<Point>(([dx, , dy]) => [
          tip[0] + dx,
          0.09 + dy,
          tip[2] - 0.05,
        ]);
        const frontRim = rearRim.map<Point>(([x, y, z]) => [x, y, z + 0.1]);
        face(rearRim, 'chair');
        face(frontRim, 'chair');
        for (let j = 0; j < rearRim.length; j++) {
          const next = (j + 1) % rearRim.length;
          face(
            [rearRim[j], rearRim[next], frontRim[next], frontRim[j]],
            'round-side',
          );
        }
      }
      box([x - 0.54, 1, z - 0.59], [1.08, 0.16, 1.18], 'chair');
      const back = x + side * 0.58;
      const backFront: Point[] = [
        [back, 1.14, z - 0.57],
        [back + side * 0.13, 2.55, z - 0.49],
        [back + side * 0.13, 2.55, z + 0.49],
        [back, 1.14, z + 0.58],
      ];
      const backRear = backFront.map<Point>(([x, y, z]) => [
        x + side * 0.1,
        y,
        z,
      ]);
      face(backRear, 'chair');
      face(backFront, 'chair');
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        face(
          [backFront[i], backFront[next], backRear[next], backRear[i]],
          'chair',
        );
      }
    }
    const arm = frontArmOnly ? 0.68 : -0.68;
    line(
      [
        [x + side * 0.2, 1.05, z + arm],
        [x + side * 0.2, 1.62, z + arm],
      ],
      'frame',
    );
    box([x - 0.42, 1.59, z + arm - 0.07], [0.72, 0.1, 0.14], 'chair');
    const angle = ((member.chairRotation ?? 0) * Math.PI) / 180;
    for (const face of faces.slice(start)) {
      face.points = face.points.map(([px, y, pz]) => [
        x + (px - x) * Math.cos(angle) - (pz - z) * Math.sin(angle),
        y,
        z + (px - x) * Math.sin(angle) + (pz - z) * Math.cos(angle),
      ]);
    }
  }

  function workstation(
    side: number,
    z: number,
    layout: {
      laptop: DeskPlacement;
      keyboard: DeskPlacement;
      mouse: DeskPlacement;
    },
  ) {
    function place([distance, offset, degrees]: DeskPlacement) {
      const angle = (degrees * Math.PI) / 180;
      return ([dx, y, dz]: Point): Point => [
        side * (distance + dx * Math.cos(angle) - dz * Math.sin(angle)),
        y,
        z + offset + dx * Math.sin(angle) + dz * Math.cos(angle),
      ];
    }

    const monitorX = side * 0.52;
    box([monitorX - 0.28, 1.8, z - 0.4], [0.56, 0.04, 0.8], 'metal');
    box([monitorX - 0.04, 1.82, z - 0.05], [0.08, 0.52, 0.1], 'metal');
    box([monitorX - 0.055, 2.08, z - 0.85], [0.11, 1.02, 1.7], 'monitor');
    const screenX = monitorX + side * 0.06;
    face(
      [
        [screenX, 2.16, z - 0.77],
        [screenX, 3.02, z - 0.77],
        [screenX, 3.02, z + 0.77],
        [screenX, 2.16, z + 0.77],
      ],
      'screen',
    );
    const keyboardPoint = place(layout.keyboard);
    const keyboardCorners = [
      [-0.245, -0.59],
      [0.245, -0.59],
      [0.245, 0.59],
      [-0.245, 0.59],
    ];
    const keyboardBase = keyboardCorners.map(([x, z]) =>
      keyboardPoint([x, 1.81, z]),
    );
    const keyboardTop = keyboardCorners.map(([x, z]) =>
      keyboardPoint([x, 1.855, z]),
    );
    for (let i = 0; i < keyboardCorners.length; i++) {
      const next = (i + 1) % keyboardCorners.length;
      face(
        [
          keyboardBase[i],
          keyboardBase[next],
          keyboardTop[next],
          keyboardTop[i],
        ],
        'keyboard',
      );
    }
    face(keyboardTop, 'keyboard');
    layer();
    for (let i = 1; i < 4; i++) {
      line(
        [
          keyboardPoint([-0.245 + i * 0.12, 1.861, -0.55]),
          keyboardPoint([-0.245 + i * 0.12, 1.861, 0.55]),
        ],
        'key',
      );
    }
    // Laptops rest directly on the desk and angle towards each seat.
    const laptopPoint = place(layout.laptop);
    face(
      [
        laptopPoint([-0.285, 1.82, -0.39]),
        laptopPoint([-0.285, 1.82, 0.39]),
        laptopPoint([0.285, 1.82, 0.39]),
        laptopPoint([0.285, 1.82, -0.39]),
      ],
      'keyboard',
    );
    face(
      [
        laptopPoint([-0.285, 1.82, -0.39]),
        laptopPoint([-0.285, 1.82, 0.39]),
        laptopPoint([-0.415, 2.43, 0.39]),
        laptopPoint([-0.415, 2.43, -0.39]),
      ],
      'monitor',
    );
    layer();

    const placeMouse = place(layout.mouse);
    const mousePoint = (front: number, across: number, y = 1.92) =>
      placeMouse([-front, y, across]);
    const mouseBase = ring(0, 0, 0, 1).map(([u, , v]) =>
      mousePoint(u * 0.22, v * 0.15, 1.82),
    );
    const mouseTop = ring(0, 0, 0, 1).map(([u, , v]) =>
      mousePoint(u * 0.2, v * 0.14, 1.91),
    );
    face(mouseBase, 'keyboard');
    for (let i = 0; i < mouseBase.length; i++) {
      const next = (i + 1) % mouseBase.length;
      face(
        [mouseBase[i], mouseBase[next], mouseTop[next], mouseTop[i]],
        'round-side',
      );
    }
    face(mouseTop, 'keyboard');
    layer();
    line([mousePoint(0.01, -0.135), mousePoint(0.01, 0.135)], 'mouse-detail');
    line([mousePoint(0.01, 0), mousePoint(0.195, 0)], 'mouse-detail');
    face(
      ring(0, 0, 0, 1).map(([u, , v]) =>
        mousePoint(0.09 + u * 0.035, v * 0.018, 1.93),
      ),
      'mouse-wheel',
    );
    layer();
  }

  // Room shell, open towards the visitor.
  face(
    [
      [-7.8, 0, -5.5],
      [7.8, 0, -5.5],
      [7.8, 0, 5],
      [-7.8, 0, 5],
    ],
    'floor',
  );
  layer();
  for (let x = -7.4; x <= 7.4; x += 0.65)
    line(
      [
        [x, 0, -5.5],
        [x, 0, 5],
      ],
      'floor-line',
    );
  for (let z = -4; z <= 4; z += 2)
    line(
      [
        [-7.8, 0, z],
        [7.8, 0, z],
      ],
      'floor-line',
    );
  layer();
  face(
    [
      [-7.8, 0, -5.5],
      [7.8, 0, -5.5],
      [7.8, 4.8, -5.5],
      [-7.8, 4.8, -5.5],
    ],
    'wall',
  );
  face(
    [
      [-7.8, 0, 5],
      [-7.8, 0, -5.5],
      [-7.8, 4.8, -5.5],
      [-7.8, 4.8, 5],
    ],
    'wall',
  );
  face(
    [
      [7.8, 0, -5.5],
      [7.8, 0, 5],
      [7.8, 4.8, 5],
      [7.8, 4.8, -5.5],
    ],
    'wall',
  );
  layer();
  // Cast onto the room's floor plane, before furniture and occupants.
  for (const member of officeMembers) {
    if (member.kind !== 'bot' || member.position[1] > 1) continue;
    const [x, , z] = member.position;
    face(
      ring(x, 0.01, z, member.movementMode === 'fly' ? 0.48 : 0.55),
      'bot-shadow',
    );
  }
  layer();
  line(
    [
      [-7.78, 0.15, 5],
      [-7.78, 0.15, -5.48],
      [7.78, 0.15, -5.48],
      [7.78, 0.15, 5],
    ],
    'architecture',
  );

  // Glass door: recessed frame and an uninterrupted clear glass panel.
  face(
    [
      [-7.76, 0.02, 2.15],
      [-7.76, 4.05, 2.15],
      [-7.76, 4.05, 4.18],
      [-7.76, 0.02, 4.18],
    ],
    'window-frame',
  );
  layer();
  face(
    [
      [-7.72, 0.12, 2.27],
      [-7.72, 3.92, 2.27],
      [-7.72, 3.92, 4.06],
      [-7.72, 0.12, 4.06],
    ],
    'door-glass',
  );
  layer();
  box([-7.68, 1.57, 2.4], [0.06, 0.27, 0.1], 'metal');
  layer();
  line(
    [
      [-7.61, 1.74, 2.45],
      [-7.45, 1.74, 2.45],
      [-7.45, 1.74, 2.83],
    ],
    'frame',
  );
  layer();

  // Corkboard on the back wall.
  box([-6.15, 2.55, -5.43], [3.1, 1.12, 0.05], 'cork');
  layer();
  for (const [x, y, degrees] of [
    [-5.75, 3.4, -8],
    [-5.31, 3.33, 5],
    [-4.93, 3.43, -3],
    [-4.37, 3.36, 11],
    [-3.85, 3.39, -6],
  ]) {
    const angle = (degrees * Math.PI) / 180;
    face(
      [
        [-0.15, -0.17],
        [0.15, -0.17],
        [0.15, 0.17],
        [-0.15, 0.17],
      ].map(
        ([dx, dy]): Point => [
          x + dx * Math.cos(angle) - dy * Math.sin(angle),
          y + dx * Math.sin(angle) + dy * Math.cos(angle),
          -5.35,
        ],
      ),
      'paper',
    );
  }

  // Right-hand window and the three narrow acoustic panels from the photos.
  for (const z of [-4.65, -3.35, 3.58]) {
    face(
      [
        [7.74, 0.18, z],
        [7.74, 4.35, z],
        [7.74, 4.35, z + 0.72],
        [7.74, 0.18, z + 0.72],
      ],
      'slat-panel',
    );
    layer();
    for (let i = 1; i < 7; i++)
      line(
        [
          [7.7, 0.18, z + i * 0.1],
          [7.7, 4.35, z + i * 0.1],
        ],
        'slat',
      );
    layer();
  }
  face(
    [
      [7.73, 1.4, -1.96],
      [7.73, 4.28, -1.96],
      [7.73, 4.28, 0.82],
      [7.73, 1.4, 0.82],
    ],
    'window-frame',
  );
  layer();
  face(
    [
      [7.69, 1.54, -1.79],
      [7.69, 4.1, -1.79],
      [7.69, 4.1, 0.65],
      [7.69, 1.54, 0.65],
    ],
    'window-opening',
  );
  layer();
  // The open sash has a solid frame, with depth perpendicular to the glass.
  const windowPoint = (u: number, y: number, depth = 0): Point => [
    7.6 - u * 1.62 + depth * 0.771,
    y,
    -1.77 + u * 1.96 + depth * 0.637,
  ];
  const sashCorners = [
    [0, 1.54],
    [0, 4.01],
    [1, 4.01],
    [1, 1.54],
  ];
  const sashFront = sashCorners.map(([u, y]) => windowPoint(u, y));
  const sashBack = sashCorners.map(([u, y]) => windowPoint(u, y, -0.1));
  // The handle stays on the room-facing side, partly hidden by the open sash.
  line(
    [
      windowPoint(0.97, 2.48, -0.1),
      windowPoint(0.97, 2.48, -0.26),
      windowPoint(0.85, 2.48, -0.26),
    ],
    'frame',
  );
  layer();
  face(sashBack, 'window-frame');
  for (let i = 0; i < sashCorners.length; i++) {
    const next = (i + 1) % sashCorners.length;
    face([sashBack[i], sashBack[next], sashFront[next], sashFront[i]], 'metal');
  }
  face(sashFront, 'window-frame');
  layer();
  face(
    [
      windowPoint(0.06, 1.7),
      windowPoint(0.06, 3.86),
      windowPoint(0.94, 3.86),
      windowPoint(0.94, 1.7),
    ],
    'glass',
  );
  layer();
  line([windowPoint(0.22, 3.2), windowPoint(0.51, 3.63)], 'reflection');
  line([windowPoint(0.32, 3.06), windowPoint(0.61, 3.49)], 'reflection');
  layer();

  // Thin landscape display mounted flush to the left wall.
  const tvPoint = (u: number, y: number, depth = 0): Point => [
    -7.72 + depth,
    y + 0.55,
    -3.25 - u,
  ];
  face(
    [
      tvPoint(-1.6, 1.8),
      tvPoint(-1.6, 3.6),
      tvPoint(1.6, 3.6),
      tvPoint(1.6, 1.8),
    ],
    'monitor',
  );
  face(
    [
      tvPoint(-1.6, 3.6),
      tvPoint(-1.6, 3.6, 0.12),
      tvPoint(1.6, 3.6, 0.12),
      tvPoint(1.6, 3.6),
    ],
    'monitor',
  );
  face(
    [
      tvPoint(-1.6, 1.8),
      tvPoint(-1.6, 1.8, 0.12),
      tvPoint(-1.6, 3.6, 0.12),
      tvPoint(-1.6, 3.6),
    ],
    'monitor',
  );
  layer();
  face(
    [
      tvPoint(-1.6, 1.8, 0.12),
      tvPoint(-1.6, 3.6, 0.12),
      tvPoint(1.6, 3.6, 0.12),
      tvPoint(1.6, 1.8, 0.12),
    ],
    'monitor',
  );
  layer();
  face(
    [
      tvPoint(-1.5, 1.91, 0.13),
      tvPoint(-1.5, 3.51, 0.13),
      tvPoint(1.5, 3.51, 0.13),
      tvPoint(1.5, 1.91, 0.13),
    ],
    'tv-screen',
  );
  layer();

  // Illustrative graph, projected directly onto the screen's plane.
  line(
    [
      tvPoint(-1.2, 3.25, 0.14),
      tvPoint(-1.2, 2.15, 0.14),
      tvPoint(1.2, 2.15, 0.14),
    ],
    'tv-axis',
  );
  line(
    [
      [-1.1, 2.35],
      [-0.75, 2.48],
      [-0.4, 2.42],
      [-0.05, 2.8],
      [0.3, 2.68],
      [0.65, 3.05],
      [1.1, 3.24],
    ].map(([u, y]) => tvPoint(u, y, 0.15)),
    'tv-graph',
  );
  layer();

  // Low cabinet and plants in front of the display, beside the entrance.
  box([-7.52, 0.08, -0.03], [1.12, 1.75, 1.9]);
  layer();
  line(
    [
      [-6.39, 0.14, 0.92],
      [-6.39, 1.78, 0.92],
    ],
    'detail',
  );
  box([-6.36, 0.88, 0.83], [0.025, 0.1, 0.045], 'metal');
  pot(-6.95, 1.85, 0.38, 0.3);
  pot(-6.95, 1.85, 1.1, 0.29);

  // Curved floor lamp and large floor plant in the front-right corner.
  face(ring(7, 0.08, 4.2, 0.34), 'metal');
  line(
    [
      [7, 0.1, 4.2],
      [7, 2.9, 4.2],
      [6.93, 3.22, 4.2],
      [6.74, 3.35, 4.2],
      [6.49, 3.35, 4.2],
    ],
    'frame',
  );
  const shadeTop = ring(6.49, 3.35, 4.2, 0.34);
  const shadeBottom = ring(6.49, 2.77, 4.2, 0.49);
  for (let i = 0; i < 16; i++) {
    const next = (i + 1) % 16;
    face(
      [shadeTop[i], shadeTop[next], shadeBottom[next], shadeBottom[i]],
      'shade',
    );
  }
  face(shadeTop, 'shade');
  pot(6.25, 0.02, 3.65, 0.48);
  layer();

  const membersByDepth = officeMembers.toSorted(
    (a, b) => project(b.position).depth - project(a.position).depth,
  );
  // Each occupant sits behind the near armrest; nearer seats cover farther ones.
  for (const member of membersByDepth) {
    if (member.position[1] <= 1) continue;
    chair(member);
    layer();
    if (member.kind === 'bot') {
      // Seated bots cast onto the cushion, directly beneath their figure.
      const [x, , z] = member.position;
      face(ring(x, 1.17, z, 0.4), 'bot-shadow');
      layer();
    }
    memberFigure(member);
    chair(member, true);
    layer();
  }

  // Four human workstations; Kristine sits beside the back-left desk.
  for (const side of [-1, 1]) {
    const x = side > 0 ? 0.025 : -2.175;
    for (const z of [-2.78, 3.38]) {
      box([x + 0.94, 0.13, z], [0.24, 1.58, 0.2], 'metal');
      box([x + 0.13, 0.06, z - 0.13], [1.86, 0.12, 0.46], 'metal');
    }
    box([x + 0.9, 1.46, -2.8], [0.32, 0.18, 6.4], 'metal');
  }
  layer();
  for (const x of [-2.175, 0.025]) {
    box([x, 1.69, -3.18], [2.15, 0.12, 7.12], 'desk');
  }
  layer();
  workstation(-1, -1.55, {
    laptop: [1.15, -1.07, 18],
    keyboard: [1.55, 0.33, -6],
    mouse: [1.72, 1.23, 12],
  });
  workstation(1, -1.55, {
    laptop: [1.15, -1.07, 18],
    keyboard: [1.55, 0.33, -6],
    mouse: [1.72, 1.23, 12],
  });
  pot(-0.38, 1.82, 0.65, 0.12);
  pot(0.38, 1.82, -0.15, 0.12);
  layer();
  workstation(-1, 2.03, {
    laptop: [1.26, -1.45, 24],
    keyboard: [1.49, 0.03, 8],
    mouse: [1.61, 0.93, -9],
  });
  workstation(1, 2.03, {
    laptop: [1.13, -1.3, 14],
    keyboard: [1.58, 0.14, -4],
    mouse: [1.47, 1.08, 17],
  });
  for (const member of membersByDepth) {
    if (member.kind === 'human') memberFigure(member, true);
    else if (member.position[1] < 1) memberFigure(member);
  }

  return layers.join('');
}

const floorCorner = project([-7.8, 0, 5]);

export const officeMarkup = `
  <section class="trust-office" id="our-first-office" aria-label="The stagewise office">
    <figure class="office-room" style="--office-caption-y: ${((floorCorner.y - 100) / 1600) * 100}%;">
      <div class="office-stage">
        <svg class="office-drawing" viewBox="-100 100 1600 650" role="img" aria-labelledby="office-drawing-title office-drawing-description">
          <title id="office-drawing-title">Our first office in Bielefeld, Germany</title>
          <desc id="office-drawing-description">Four people sit at the desks: Jakob at the front left, a teammate at the back left, Glenn at the back right, and Julian at the front right. Kristine, a Klex Bot, sits beside the back-left desk. Jonathan and Harry sit on the floor to the left and right of the desks. Hover over a bot to see what they do.</desc>
          ${roomDrawing()}
        </svg>
        <div class="office-team-mount"></div>
      </div>
      <figcaption class="office-caption">
        Our Klex Bots are not physically in the office… but sometimes it almost feels like they are.
      </figcaption>
    </figure>
  </section>
`;
