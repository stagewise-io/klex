import type { OfficeMember } from './office-members';

// Seated figures are drawn in a vertical plane through their chair. The room
// places bodies behind the desks and forearms above the desktop equipment.
export function officeFigure(member: OfficeMember, armsOnly = false) {
  if (member.kind === 'bot') {
    const size = member.position[1] > 1 ? 0.0074 : 0.01;
    return `<g class="office-bot-figure" transform="translate(${-80 * size} ${-138 * size}) scale(${size})">
      <foreignObject width="160" height="160" overflow="visible">
        <div xmlns="http://www.w3.org/1999/xhtml" data-office-bot="${member.id}" aria-hidden="true"></div>
      </foreignObject>
    </g>`;
  }

  // Keep the rear shoulder behind the torso; only its exposed arm crosses the desk.
  const rearArm = 'M0.1 -1.12 L0.56 -0.72 H1.15';
  const rearArmClip = `office-${member.id}-rear-arm-clip`;
  const limbs = armsOnly
    ? [rearArm, 'M0 -0.99 L0.48 -0.52 H1.07']
    : [
        'M0.08 0.07 H0.72 L0.53 0.96 H0.8',
        'M-0.04 0.19 H0.54 L0.35 1.08 H0.62',
        rearArm,
      ];
  return `<g class="office-human-figure" transform="scale(${-member.side} 1)">
    ${armsOnly ? `<defs><clipPath id="${rearArmClip}"><rect x="0.24" y="-2" width="2" height="3" /></clipPath></defs>` : ''}
    ${limbs
      .map((limb, index) => {
        const paths = `
    <path class="office-person-limb" d="${limb}" />
    <path class="office-person-limb office-person-limb-fill" d="${limb}" />`;
        return armsOnly && index === 0
          ? `<g clip-path="url(#${rearArmClip})">${paths}</g>`
          : paths;
      })
      .join('')}
    ${
      armsOnly
        ? ''
        : `
      <rect class="office-person-body" x="-0.07" y="-1.4" width="0.1" height="0.25" />
      <rect class="office-person-body" x="-0.27" y="-1.21" width="0.5" height="1.5" rx="0.18" />
      <circle class="office-person-body" cx="-0.02" cy="-1.63" r="0.26" />
    `
    }
  </g>`;
}
