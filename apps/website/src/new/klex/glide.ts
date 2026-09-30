import { gsap } from 'gsap';

import { roundedPath } from '../../mascot/geometry';
import { createActivity, type KlexActivity } from './activity';
import {
  type Emote,
  type EmoteLook,
  emoteLook,
  emotePose,
  REST_EMOTE,
} from './emotes';
import { fitGaze, gazeRoom } from './gaze';
import { mirroredOutline, waveAnchor } from './geometry';
import { BODY_SHAPES, type BodyShape, DEFAULT_GLIDE } from './presets';

export { DEFAULT_GLIDE } from './presets';

type GlideSettings = typeof DEFAULT_GLIDE;
export type KlexPosition = { x: number; y: number };

function setAttribute(
  element: Element | null | undefined,
  name: string,
  value: string,
) {
  if (element && element.getAttribute(name) !== value)
    element.setAttribute(name, value);
}

function transformSetter(
  element: HTMLElement,
  property: string,
  unit?: string,
) {
  const set = gsap.quickSetter(element, property, unit);
  let previous: number | undefined;
  return (value: number) => {
    if (value === previous) return;
    previous = value;
    set(value);
  };
}

const REST = {
  facing: 1,
  look: 1,
  lean: 0,
  drag: 0,
  energy: 0,
  phase: 0,
  crawl: 1,
  floating: 0,
  compression: 0,
};

const damp = (from: number, to: number, rate: number, dt: number) =>
  to + (from - to) * Math.exp(-rate * dt);

function crawlReach(pose: typeof REST, settings: GlideSettings) {
  return (
    Math.sin(pose.phase) *
    pose.energy *
    pose.crawl *
    settings.softness *
    Math.min(18, settings.wavelength / (Math.PI * 2))
  );
}

function compressPoint(x: number, y: number, compression: number) {
  return [
    80 + (x - 80) * (1 + compression * 0.5),
    128 + (y - 128) * (1 - compression),
  ] as const;
}

function headMotion(
  pose: typeof REST,
  settings: GlideSettings,
  shape: BodyShape,
  reaction = REST_EMOTE,
) {
  const nod =
    settings.nod *
    settings.softness *
    pose.energy *
    Math.sin(pose.phase + 0.35);
  const angle =
    pose.facing *
    (nod * 0.065 + reaction.nod * 0.14 + (reaction.headTilt * Math.PI) / 180);
  const pivotX =
    80 +
    (shape.eyeX - 8) * pose.facing +
    pose.facing * crawlReach(pose, settings) +
    settings.softness * pose.lean * 8;
  return {
    angle: (angle * 180) / Math.PI,
    point(x: number, y: number, weight = 1) {
      const rotation = angle * weight;
      const dx = x - pivotX;
      const pivotY = shape.eyeY + 39;
      const dy = y - pivotY;
      return [
        pivotX +
          dx * Math.cos(rotation) -
          dy * Math.sin(rotation) +
          (reaction.headSway * pose.facing + reaction.gazeHeadX) * weight ** 2,
        pivotY +
          dx * Math.sin(rotation) +
          dy * Math.cos(rotation) +
          (nod + reaction.nod) * 2 * weight +
          reaction.gazeHeadY * weight ** 2,
      ] as const;
    },
  };
}

function deformPoint(
  x: number,
  y: number,
  reaction: typeof REST_EMOTE,
  bodyHeight: number,
  eyeOffset: number,
) {
  const height = (128 - y) / 110;
  const h = gsap.utils.clamp(0, 1, (128 - y) / bodyHeight);
  // A moving band swells both sides of the belly. The crown and sole have
  // zero weight, so this reads as jelly travelling upwards, not a head shake.
  const ripple =
    reaction.ripple *
    Math.sin(reaction.ripplePhase - h * Math.PI * 2) *
    Math.sin(h * Math.PI) ** 2;
  const center = 80 + eyeOffset * h;
  return [
    80 +
      (x - 80) * (1 + reaction.puff * 0.12) +
      reaction.wave * Math.sin(height * Math.PI * 2) * height +
      (x - center) * ripple * 0.48,
    128 + (y - 128) * (1 + reaction.puff * 0.04) + ripple * 2,
  ] as const;
}

function rotatePoint(x: number, y: number, angle: number) {
  const radians = (angle * Math.PI) / 180;
  return [
    80 + (x - 80) * Math.cos(radians) - (y - 126) * Math.sin(radians),
    126 + (x - 80) * Math.sin(radians) + (y - 126) * Math.cos(radians),
  ] as const;
}

function bodyRig(
  pose: typeof REST,
  settings: GlideSettings,
  shape: BodyShape,
  reaction: typeof REST_EMOTE,
) {
  const { facing, lean, drag, energy, phase } = pose;
  const { softness } = settings;
  const reach = crawlReach(pose, settings);
  const head = headMotion(pose, settings, shape, reaction);
  const outline = shape.outline;
  const mirrored = mirroredOutline(shape);
  const bodyHeight = 128 - Math.min(...outline.map((point) => point[1]));
  const points = outline.map(([rightX, rightY], index) => {
    const [leftX, leftY] = mirrored[index] ?? [160 - rightX, rightY];
    const blend = (facing + 1) / 2;
    let x = leftX * (1 - blend) + rightX * blend;
    let y = leftY * (1 - blend) + rightY * blend;
    const shoulder = shape.eyeY + 7;
    const belly = gsap.utils.clamp(0, 1, (y - shoulder) / (128 - shoulder));
    // The trailing mass tucks behind the body in front view, not out to its sides.
    x = 80 + (x - 80) * (1 - (0.05 + 0.15 * belly) * (1 - facing * facing));
    const tail = Math.max(0, (-facing * (x - 80)) / 66);
    const segment =
      1 - belly + belly * gsap.utils.clamp(-1, 1, (facing * (x - 80) + 8) / 38);
    const gathering =
      pose.crawl * softness * energy * Math.max(0, -Math.sin(phase));
    // Front and tail alternate their advance. Mass bunches above the sole
    // as the rear catches up; the underside never lifts like a fabric hem.
    x += facing * reach * segment;
    x += softness * (lean * 8 * (1 - belly) - drag * 5 * tail);
    x -= facing * gathering * 5 * tail;
    y += pose.crawl * softness * energy * 12 * (1 - belly);
    y -= gathering * 28 * belly * (1 - belly);
    y -= pose.floating * 8 * belly * Math.min(1, Math.abs(x - 80) / 55);
    const [headX, headY] = head.point(x, y, 1 - belly);
    const compressed = compressPoint(
      headX,
      headY,
      gsap.utils.clamp(-0.2, 0.45, pose.compression + reaction.compression),
    );
    const [deformedX, deformedY] = deformPoint(
      ...compressed,
      reaction,
      bodyHeight,
      shape.eyeX * facing,
    );
    const angle = (index / outline.length) * Math.PI * 2;
    const meltedX =
      deformedX * (1 - reaction.melt) +
      (80 + 61 * Math.sin(angle)) * reaction.melt;
    const meltedY =
      deformedY * (1 - reaction.melt) +
      (116 - 12 * Math.cos(angle)) * reaction.melt;
    return rotatePoint(meltedX, meltedY, reaction.roll * facing);
  });
  // Rotate the body and its face together, lifting by the same amount so a
  // fallen silhouette never passes through the floor, including custom shapes.
  const floorOffset = reaction.roll
    ? Math.max(...points.map((point) => point[1])) - 128
    : 0;
  const sideOffset = reaction.roll
    ? ((Math.min(...points.map((point) => point[0])) +
        Math.max(...points.map((point) => point[0]))) /
        2 -
        80) *
      Math.min(1, Math.abs(reaction.roll) / 90)
    : 0;
  return {
    points: points.map(
      ([x, y]) =>
        [
          80 + (x - sideOffset - 80) * (1 + reaction.impact * 0.3),
          128 + (y - floorOffset - 128) * (1 - reaction.impact),
        ] as const,
    ),
    floorOffset,
    sideOffset,
    bodyHeight,
  };
}

// The rounded tail and broad sole keep the crawl soft and grounded.
export function klexBody(
  pose = REST,
  settings = DEFAULT_GLIDE,
  shape: BodyShape = BODY_SHAPES[0],
  reaction = REST_EMOTE,
) {
  reaction = fitGaze(
    reaction,
    reaction.lookX || reaction.lookY ? gazeRoom(shape) : 0,
  );
  const displayPose = {
    ...pose,
    facing: pose.facing * (1 - 2 * reaction.turn),
  };
  return roundedPath(bodyRig(displayPose, settings, shape, reaction).points);
}

type GlideElements = {
  travel: HTMLDivElement;
  actor: HTMLDivElement;
  shadow: SVGEllipseElement;
  body: SVGPathElement;
  eyes: SVGGElement;
  laptop?: SVGGElement;
};

// Keep one controller for the mounted figure, including interrupted moves.
export function createGlide(
  { travel, actor, shadow, body, eyes, laptop }: GlideElements,
  onComplete: () => void,
  onEmoteComplete: () => void = () => {},
  onLookChange: (look: EmoteLook) => void = () => {},
  initialSettings: GlideSettings = DEFAULT_GLIDE,
  initialPosition: KlexPosition = { x: 0, y: 0 },
  onDepthChange: (y: number) => void = () => {},
  onArrival: () => void = () => {},
) {
  const flyingInitially = initialSettings.mode === 'fly';
  const pose = {
    ...REST,
    crawl: flyingInitially ? 0 : 1,
    floating: flyingInitially ? 1 : 0,
    energy: flyingInitially ? 1 : 0,
  };
  const setX = transformSetter(travel, 'xPercent');
  const setGroundY = transformSetter(travel, 'y', 'px');
  const setY = transformSetter(actor, 'y', 'px');
  const setShake = transformSetter(actor, 'x', 'px');
  const setRotation = transformSetter(actor, 'rotation', 'deg');
  gsap.set(actor, { transformOrigin: '50% 90%' });
  let settings = initialSettings;
  let shape: BodyShape = BODY_SHAPES[0];
  let scale = 1;
  let eyeRoom = gazeRoom(shape);
  let reducedMotion = false;
  let position = gsap.utils.clamp(-50, 50, initialPosition.x);
  let positionY = initialPosition.y;
  let velocity = 0;
  let velocityY = 0;
  let target = position;
  let targetY = positionY;
  let reportedY: number | undefined;
  let direction = 1;
  let paused = false;
  let running = false;
  let busy = false;
  let arrivalPending = false;
  let transitioning = false;
  let disposed = false;
  let height = flyingInitially ? 64 : 0;
  let activity: KlexActivity | false = false;
  const activityMotion = createActivity();
  let emote: { action: Emote; time: number } | null = null;
  let lastLook: EmoteLook = {};
  const leftEye = eyes.querySelector<SVGGElement>('[data-eye="left"]');
  const rightEye = eyes.querySelector<SVGGElement>('[data-eye="right"]');
  const leftClosed = eyes.querySelector<SVGPathElement>(
    '[data-eye-closed="left"]',
  );
  const rightClosed = eyes.querySelector<SVGPathElement>(
    '[data-eye-closed="right"]',
  );
  let hop: {
    from: number;
    to: number;
    fromY: number;
    toY: number;
    time: number;
    duration: number;
    height: number;
    load: number;
  } | null = null;

  function render() {
    const laptopScale = reducedMotion
      ? Number(activity === 'working')
      : activityMotion.laptopScale;
    const laptopX = 98 + shape.eyeX * 0.4;
    const laptopY = (Math.max(76, shape.eyeY + 20) + 120) / 2;
    setAttribute(
      laptop,
      'transform',
      `translate(${shape.eyeX * 0.4 * (pose.facing - 1)} ${reducedMotion ? 0 : activityMotion.workingBob}) translate(${laptopX} ${laptopY}) scale(${laptopScale}) translate(${-laptopX} ${-laptopY})`,
    );
    setAttribute(laptop, 'opacity', String(Number(laptopScale > 0)));
    const resting = !busy && !transitioning && !emote;
    const restingPose = activityMotion.pose(
      reducedMotion ? activity : undefined,
    );
    const rawReaction = emote
      ? emotePose(emote.action.id, emote.time / emote.action.duration)
      : REST_EMOTE;
    const reaction = fitGaze(
      {
        ...rawReaction,
        compression: rawReaction.compression + restingPose.compression,
        headSway: rawReaction.headSway + restingPose.headSway,
        headTilt: rawReaction.headTilt + restingPose.headTilt,
        nod: rawReaction.nod + restingPose.nod,
        lookX: rawReaction.lookX + restingPose.lookX,
        lookY: rawReaction.lookY + restingPose.lookY,
        blinkLeft: emote ? rawReaction.blinkLeft : restingPose.blinkLeft,
        blinkRight: emote ? rawReaction.blinkRight : restingPose.blinkRight,
      },
      eyeRoom,
    );
    const look: EmoteLook = emote
      ? emoteLook(emote.action.id, emote.time / emote.action.duration)
      : resting && activity === 'working'
        ? {
            expression: 'neutral',
            extra:
              !reducedMotion && activityMotion.thinking
                ? 'question'
                : undefined,
          }
        : resting && activity === 'sleeping'
          ? { extra: 'sleep' }
          : {};
    if (
      look.expression !== lastLook.expression ||
      look.extra !== lastLook.extra
    ) {
      lastLook = look;
      onLookChange(look);
    }
    const displayPose = {
      ...pose,
      facing: pose.facing * (1 - 2 * reaction.turn),
    };
    const displayHeight = height + reaction.lift;
    setX(position);
    setGroundY(positionY);
    if (positionY !== reportedY) {
      reportedY = positionY;
      onDepthChange(positionY);
    }
    setY(-displayHeight * scale);
    setShake(reaction.shake * pose.facing * scale);
    setRotation(pose.floating * pose.lean * 5);
    setAttribute(
      shadow,
      'rx',
      String(51 * Math.max(0.25, 1 - displayHeight / 180)),
    );
    setAttribute(
      shadow,
      'opacity',
      String(Math.max(0.35, 1 - displayHeight / 180)),
    );
    const rig = bodyRig(displayPose, settings, shape, reaction);
    setAttribute(body, 'd', roundedPath(rig.points));
    const head = headMotion(displayPose, settings, shape, reaction);
    const [headX, headY] = head.point(
      80 +
        shape.eyeX * displayPose.facing +
        3 * (pose.look - pose.facing) +
        displayPose.facing * crawlReach(pose, settings) +
        settings.softness * pose.lean * 8,
      shape.eyeY + pose.crawl * settings.softness * pose.energy * 12,
    );
    const compressed = compressPoint(
      headX,
      headY,
      gsap.utils.clamp(-0.2, 0.45, pose.compression + reaction.compression),
    );
    const [deformedX, deformedY] = deformPoint(
      ...compressed,
      reaction,
      rig.bodyHeight,
      shape.eyeX * displayPose.facing,
    );
    const [eyeX, eyeY] = rotatePoint(
      deformedX * (1 - reaction.melt) +
        (80 + shape.eyeX * displayPose.facing * 0.3) * reaction.melt,
      deformedY * (1 - reaction.melt) + 116 * reaction.melt,
      reaction.roll * displayPose.facing,
    );
    const faceX =
      80 + (eyeX - rig.sideOffset - 80) * (1 + reaction.impact * 0.3);
    const faceY = 128 + (eyeY - rig.floorOffset - 128) * (1 - reaction.impact);
    const faceAngle =
      head.angle * (1 - reaction.melt) + reaction.roll * displayPose.facing;
    setAttribute(
      eyes,
      'transform',
      `translate(${faceX} ${faceY}) rotate(${faceAngle})`,
    );
    const hand = eyes.querySelector('[data-wave-anchor]');
    if (hand) {
      const anchor = waveAnchor({
        ...shape,
        outline: rig.points,
        eyeX: faceX - 80,
        eyeY: faceY,
      });
      // Undo the face rotation so the hand stays on the body's right edge.
      const angle = (-faceAngle * Math.PI) / 180;
      const x = anchor.x * Math.cos(angle) - anchor.y * Math.sin(angle);
      const y = anchor.x * Math.sin(angle) + anchor.y * Math.cos(angle);
      setAttribute(hand, 'transform', `translate(${x} ${y})`);
    }
    setAttribute(eyes, 'opacity', String(1 - reaction.hideEyes));
    for (const [eye, closed, blink] of [
      [leftEye, leftClosed, reaction.blinkLeft],
      [rightEye, rightClosed, reaction.blinkRight],
    ] as const) {
      const openness = Math.max(0, 1 - blink);
      setAttribute(
        eye,
        'transform',
        `translate(${reaction.lookX} ${reaction.lookY}) scale(1 ${openness})`,
      );
      // Crossfade into a closed lid rather than making the eye disappear.
      const visible = Math.min(1, openness * 4);
      setAttribute(eye, 'opacity', String(visible));
      setAttribute(closed, 'opacity', String(1 - visible));
      setAttribute(
        closed,
        'transform',
        `translate(${reaction.lookX} ${reaction.lookY})`,
      );
    }
  }

  function stop() {
    gsap.ticker.remove(tick);
    running = false;
  }

  function tick(_time: number, deltaMs: number) {
    const flying = settings.mode === 'fly';
    if (reducedMotion) {
      position = target;
      positionY = targetY;
      velocity = 0;
      velocityY = 0;
      height = flying ? 64 : 0;
      hop = null;
      Object.assign(pose, REST, {
        facing: direction,
        look: direction,
        crawl: settings.mode === 'crawl' ? 1 : 0,
        floating: flying ? 1 : 0,
        energy: flying ? 1 : 0,
      });
      transitioning = false;
      stop();
      const completed = busy;
      busy = false;
      render();
      if (arrivalPending) {
        arrivalPending = false;
        onArrival();
      }
      if (completed) onComplete();
      return;
    }
    // Substeps keep braking stable at lower frame rates. Limit elapsed time
    // so returning to a background tab cannot jump the character ahead.
    const elapsed = Math.min(deltaMs / 1000, 0.05);
    const resting = !busy && !transitioning && !emote;
    activityMotion.advance(elapsed, resting ? activity : false);
    if (emote) {
      emote.time += elapsed;
      if (emote.time >= emote.action.duration) {
        emote = null;
        onEmoteComplete();
      }
    }
    // Completion callbacks can start travel. Only then do pixel distances matter;
    // resting avatars avoid flushing layout after another avatar's SVG updates.
    const width = busy ? Math.max(1, travel.clientWidth) : 1;
    const steps = Math.max(1, Math.ceil(elapsed * 120));
    const dt = elapsed / steps;
    for (let i = 0; i < steps; i++) {
      const distance = ((target - position) * width) / 100;
      const distanceY = targetY - positionY;
      const length = Math.hypot(distance, distanceY);
      const desiredSpeed = Math.min(settings.speed, length * 3);
      const desiredY = length ? (distanceY / length) * desiredSpeed : 0;
      let compression = 0;
      if (settings.mode === 'hop') {
        if (!hop && height < 0.1 && busy && length > 0.1) {
          // Equal strides avoid a tiny correction hop at the destination.
          const strides = Math.ceil(length / settings.wavelength);
          const stride = distance / strides;
          const strideY = distanceY / strides;
          const strideLength = Math.hypot(stride, strideY);
          hop = {
            from: position,
            to: position + (stride * 100) / width,
            fromY: positionY,
            toY: positionY + strideY,
            time: 0,
            duration: gsap.utils.clamp(
              0.55,
              1.2,
              strideLength / settings.speed,
            ),
            height: Math.min(76, 24 + strideLength * 0.3),
            load: pose.compression,
          };
        }
        if (hop) {
          hop.time = Math.min(hop.duration, hop.time + dt);
          const progress = hop.time / hop.duration;
          const air = gsap.utils.clamp(0, 1, (progress - 0.14) / 0.68);
          position = hop.from + (hop.to - hop.from) * air * air * (3 - 2 * air);
          positionY =
            hop.fromY + (hop.toY - hop.fromY) * air * air * (3 - 2 * air);
          velocity =
            ((((hop.to - hop.from) * width) / 100) * 6 * air * (1 - air)) /
            (hop.duration * 0.68);
          velocityY =
            ((hop.toY - hop.fromY) * 6 * air * (1 - air)) /
            (hop.duration * 0.68);
          height = 4 * hop.height * air * (1 - air);
          pose.phase = progress * Math.PI * 2;
          compression =
            progress < 0.14
              ? hop.load +
                (0.24 * settings.softness - hop.load) *
                  Math.sin(((progress / 0.14) * Math.PI) / 2)
              : progress < 0.82
                ? -0.12 * settings.softness * Math.sin(air * Math.PI)
                : 0.24 *
                  settings.softness *
                  Math.sin((((progress - 0.82) / 0.18) * Math.PI) / 2);
          if (progress === 1) hop = null;
        } else {
          velocity = damp(velocity, 0, 12, dt);
          velocityY = damp(velocityY, 0, 12, dt);
          height = damp(height, 0, 10, dt);
        }
      } else {
        const desired = length ? (distance / length) * desiredSpeed : 0;
        velocity = damp(velocity, desired, 12, dt);
        position = gsap.utils.clamp(
          -50,
          50,
          position + (velocity * dt * 100) / width,
        );
        velocityY = damp(velocityY, desiredY, 12, dt);
        positionY += velocityY * dt;
        pose.phase +=
          ((flying ? settings.speed * 0.45 : Math.hypot(velocity, velocityY)) *
            dt *
            Math.PI *
            2) /
          settings.wavelength;
        height = damp(
          height,
          flying ? 64 + 7 * Math.sin(pose.phase) : 0,
          8,
          dt,
        );
      }
      pose.crawl = damp(pose.crawl, settings.mode === 'crawl' ? 1 : 0, 10, dt);
      pose.floating = damp(pose.floating, flying ? 1 : 0, 8, dt);
      pose.compression = damp(pose.compression, compression, 24, dt);
      pose.facing = damp(pose.facing, direction, settings.turn, dt);
      pose.look = damp(pose.look, direction, 15, dt);
      pose.lean = damp(pose.lean, velocity / 180, 11, dt);
      pose.drag = damp(pose.drag, velocity / 180, 5 / settings.lag, dt);
      pose.energy = damp(
        pose.energy,
        flying || hop ? 1 : Math.min(1, Math.hypot(velocity, velocityY) / 80),
        8,
        dt,
      );
    }

    // Conversation can begin at the destination while the body settles.
    if (
      arrivalPending &&
      !hop &&
      Math.hypot(((target - position) * width) / 100, targetY - positionY) <
        2 &&
      Math.hypot(velocity, velocityY) < 12
    ) {
      arrivalPending = false;
      onArrival();
    }

    const arrived =
      !hop &&
      Math.abs(((target - position) * width) / 100) < 0.1 &&
      Math.abs(targetY - positionY) < 0.1 &&
      Math.abs(velocity) < 0.2 &&
      Math.abs(velocityY) < 0.2 &&
      Math.abs(pose.drag) < 0.003 &&
      Math.abs(pose.facing - direction) < 0.003;
    const settled =
      pose.energy < 0.003 &&
      height < 0.1 &&
      Math.abs(pose.compression) < 0.003 &&
      pose.floating < 0.003;
    if (arrived && (flying || settled)) {
      position = target;
      positionY = targetY;
      velocity = 0;
      velocityY = 0;
      transitioning = false;
      if (!flying) {
        height = 0;
        Object.assign(pose, REST, {
          facing: direction,
          look: direction,
          crawl: settings.mode === 'crawl' ? 1 : 0,
        });
        if (!emote && !activity && !activityMotion.active) stop();
      }
      render();
      if (busy) {
        busy = false;
        onComplete();
      }
      return;
    }
    render();
  }

  function wake() {
    if (
      !disposed &&
      !running &&
      !paused &&
      (busy ||
        transitioning ||
        emote ||
        ((activity || activityMotion.active) && !reducedMotion) ||
        (settings.mode === 'fly' && !reducedMotion))
    ) {
      running = true;
      gsap.ticker.add(tick);
    }
  }

  render();
  return {
    playEmote(action: Emote) {
      if (disposed || reducedMotion || emote) return false;
      emote = { action, time: 0 };
      render();
      wake();
      return true;
    },
    cancelEmote() {
      if (!emote) return;
      emote = null;
      onEmoteComplete();
      render();
    },
    moveTo(next: number | KlexPosition) {
      target = gsap.utils.clamp(
        -50,
        50,
        typeof next === 'number' ? next : next.x,
      );
      targetY = typeof next === 'number' ? positionY : next.y;
      if (target !== position) direction = target < position ? -1 : 1;
      busy = true;
      arrivalPending = true;
      wake();
    },
    shiftBy(offset: KlexPosition) {
      position += offset.x;
      positionY += offset.y;
      target += offset.x;
      targetY += offset.y;
      if (hop) {
        hop.from += offset.x;
        hop.to += offset.x;
        hop.fromY += offset.y;
        hop.toY += offset.y;
      }
      render();
    },
    snapTo(next: KlexPosition) {
      position = target = gsap.utils.clamp(-50, 50, next.x);
      positionY = targetY = next.y;
      velocity = velocityY = 0;
      hop = null;
      busy = false;
      arrivalPending = false;
      const flying = settings.mode === 'fly';
      height = flying ? 64 : 0;
      Object.assign(pose, REST, {
        facing: direction,
        look: direction,
        crawl: settings.mode === 'crawl' ? 1 : 0,
        floating: flying ? 1 : 0,
        energy: flying ? 1 : 0,
      });
      render();
    },
    face(side: 'left' | 'right') {
      direction = side === 'left' ? -1 : 1;
      pose.facing = pose.look = direction;
      render();
    },
    stopMoving() {
      target = position;
      targetY = positionY;
      velocity = 0;
      velocityY = 0;
      hop = null;
      busy = false;
      arrivalPending = false;
    },
    configure(
      next: GlideSettings,
      reduced: boolean,
      nextShape: BodyShape = BODY_SHAPES[0],
      nextScale = 1,
      nextIdle = false,
      nextActivity: KlexActivity = 'idle',
    ) {
      const modeChanged = settings.mode !== next.mode;
      const motionChanged = reducedMotion !== reduced;
      settings = next;
      reducedMotion = reduced;
      activity = nextActivity === 'idle' && !nextIdle ? false : nextActivity;
      if (reduced) activityMotion.snapLaptop(activity === 'working');
      if (reduced && emote) {
        emote = null;
        onEmoteComplete();
      }
      if (modeChanged || motionChanged) {
        hop = null;
        transitioning = modeChanged || reduced;
        wake();
      }
      if (shape !== nextShape || scale !== nextScale) {
        shape = nextShape;
        scale = nextScale;
        eyeRoom = gazeRoom(shape);
      }
      render();
      wake();
    },
    pause(next: boolean) {
      paused = next;
      if (paused) stop();
      else wake();
    },
    dispose() {
      disposed = true;
      busy = false;
      emote = null;
      stop();
    },
  };
}
