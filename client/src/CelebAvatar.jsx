// Retro sketch-style SVG avatars for celebrity panelists
// Each avatarType gets a distinct illustrated look, 1970s game show aesthetic

const PALETTE = {
  skin1: '#F5CBA7', skin2: '#F0A050', skin3: '#C68642',
  hair1: '#2C1810', hair2: '#8B4513', hair3: '#D4A017', hair4: '#F5F5DC', hair5: '#1A1A1A',
  outline: '#2b1810',
  bg: '#fff4d6',
};

// Shared base elements
const Face = ({ cx, cy, rx, ry, fill }) => (
  <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={fill} stroke={PALETTE.outline} strokeWidth="2" />
);
const Eye = ({ cx, cy }) => (
  <>
    <ellipse cx={cx} cy={cy} rx="3.5" ry="4" fill="white" stroke={PALETTE.outline} strokeWidth="1.5" />
    <circle cx={cx} cy={cy+0.5} r="2" fill={PALETTE.outline} />
  </>
);
const Smile = ({ x1, y1, x2, y2, cpx, cpy }) => (
  <path d={`M${x1},${y1} Q${cpx},${cpy} ${x2},${y2}`} fill="none" stroke={PALETTE.outline} strokeWidth="2" strokeLinecap="round" />
);
const Neck = ({ cx, y, fill }) => (
  <rect x={cx-10} y={y} width="20" height="16" fill={fill} stroke={PALETTE.outline} strokeWidth="1.5" />
);

// ── Avatar types ───────────────────────────────────────────────

function ManYoung() {
  return (
    <g>
      {/* Shoulders / shirt */}
      <path d="M18,115 Q30,95 50,90 Q70,95 82,115 L82,130 L18,130Z" fill="#3a6fd8" stroke={PALETTE.outline} strokeWidth="2"/>
      {/* Collar */}
      <path d="M42,90 L50,105 L58,90" fill="white" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Neck cx={50} y={76} fill={PALETTE.skin1} />
      {/* Head */}
      <Face cx={50} cy={58} rx={28} ry={32} fill={PALETTE.skin1} />
      {/* Hair - short modern */}
      <path d="M22,52 Q24,24 50,22 Q76,24 78,52 Q70,36 50,34 Q30,36 22,52Z" fill={PALETTE.hair1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Eye cx={39} cy={56} /> <Eye cx={61} cy={56} />
      {/* Nose */}
      <path d="M48,63 Q50,70 52,63" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Smile x1={38} y1={74} x2={62} y2={74} cpx={50} cpy={82} />
      {/* Ear */}
      <ellipse cx={22} cy={60} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={78} cy={60} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
    </g>
  );
}

function ManMiddle() {
  return (
    <g>
      {/* Suit */}
      <path d="M15,115 Q28,92 50,88 Q72,92 85,115 L85,130 L15,130Z" fill="#2c3e50" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M50,88 L44,105 L50,110 L56,105Z" fill="white" stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Tie */}
      <path d="M48,105 L50,125 L52,105 L50,108Z" fill="#c0392b" stroke={PALETTE.outline} strokeWidth="1"/>
      <Neck cx={50} y={75} fill={PALETTE.skin2} />
      <Face cx={50} cy={56} rx={28} ry={33} fill={PALETTE.skin2} />
      {/* Hair - side part */}
      <path d="M22,48 Q26,20 50,19 Q74,20 78,48 Q72,30 55,28 Q32,25 22,48Z" fill={PALETTE.hair2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Eye cx={39} cy={54} /> <Eye cx={61} cy={54} />
      {/* Nose */}
      <ellipse cx={50} cy={63} rx="4" ry="5" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Smile x1={37} y1={73} x2={63} y2={73} cpx={50} cpy={81} />
      {/* Ears */}
      <ellipse cx={22} cy={58} rx="5" ry="7" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={78} cy={58} rx="5" ry="7" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Slight jowl lines */}
      <path d="M30,70 Q26,78 30,82" fill="none" stroke={PALETTE.outline} strokeWidth="1" opacity="0.4"/>
      <path d="M70,70 Q74,78 70,82" fill="none" stroke={PALETTE.outline} strokeWidth="1" opacity="0.4"/>
    </g>
  );
}

function ManOlder() {
  return (
    <g>
      {/* Cardigan */}
      <path d="M14,115 Q27,90 50,86 Q73,90 86,115 L86,130 L14,130Z" fill="#7f8c8d" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M43,86 L50,100 L57,86" fill="#ecf0f1" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Neck cx={50} y={74} fill={PALETTE.skin1} />
      <Face cx={50} cy={55} rx={29} ry={33} fill={PALETTE.skin1} />
      {/* White/grey hair - fuller on sides */}
      <path d="M21,52 Q23,18 50,16 Q77,18 79,52 Q76,32 62,29 Q50,27 38,29 Q24,32 21,52Z" fill={PALETTE.hair4} stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Bald patch */}
      <ellipse cx={50} cy={28} rx={18} ry={10} fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1"/>
      <Eye cx={39} cy={53} /> <Eye cx={61} cy={53} />
      {/* Glasses */}
      <rect x={31} y={47} width={17} height={13} rx="4" fill="none" stroke={PALETTE.outline} strokeWidth="2"/>
      <rect x={52} y={47} width={17} height={13} rx="4" fill="none" stroke={PALETTE.outline} strokeWidth="2"/>
      <line x1={48} y1={53} x2={52} y2={53} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <line x1={31} y1={53} x2={26} y2={56} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <line x1={69} y1={53} x2={74} y2={56} stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Nose - larger */}
      <path d="M46,62 Q50,72 54,62" fill="none" stroke={PALETTE.outline} strokeWidth="2"/>
      <Smile x1={36} y1={74} x2={64} y2={74} cpx={50} cpy={80} />
      {/* Wrinkle lines */}
      <path d="M29,62 Q27,70 30,76" fill="none" stroke={PALETTE.outline} strokeWidth="1" opacity="0.5"/>
      <path d="M71,62 Q73,70 70,76" fill="none" stroke={PALETTE.outline} strokeWidth="1" opacity="0.5"/>
      <ellipse cx={21} cy={58} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={79} cy={58} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
    </g>
  );
}

function WomanYoung() {
  return (
    <g>
      {/* Top */}
      <path d="M16,115 Q28,88 50,84 Q72,88 84,115 L84,130 L16,130Z" fill="#e74c8b" stroke={PALETTE.outline} strokeWidth="2"/>
      {/* Neckline */}
      <path d="M38,84 Q50,96 62,84" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Neck cx={50} y={72} fill={PALETTE.skin1} />
      <Face cx={50} cy={52} rx={27} ry={31} fill={PALETTE.skin1} />
      {/* Long hair */}
      <path d="M23,48 Q25,18 50,16 Q75,18 77,48 Q80,65 78,90 Q65,80 50,82 Q35,80 22,90 Q20,65 23,48Z" fill={PALETTE.hair1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Face over hair */}
      <ellipse cx={50} cy={52} rx={27} ry={31} fill={PALETTE.skin1} stroke="none"/>
      {/* Eyebrows */}
      <path d="M34,42 Q39,39 44,41" fill="none" stroke={PALETTE.outline} strokeWidth="2" strokeLinecap="round"/>
      <path d="M56,41 Q61,39 66,42" fill="none" stroke={PALETTE.outline} strokeWidth="2" strokeLinecap="round"/>
      <Eye cx={39} cy={50} /> <Eye cx={61} cy={50} />
      {/* Small nose */}
      <path d="M48,58 Q50,63 52,58" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Lips */}
      <path d="M40,70 Q50,76 60,70" fill="#e8899a" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <path d="M40,70 Q50,68 60,70" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={22} cy={54} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={78} cy={54} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
    </g>
  );
}

function WomanMiddle() {
  return (
    <g>
      {/* Blazer */}
      <path d="M14,115 Q27,90 50,86 Q73,90 86,115 L86,130 L14,130Z" fill="#8e44ad" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M44,86 L50,102 L56,86" fill="#f8f9fa" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Neck cx={50} y={74} fill={PALETTE.skin2} />
      <Face cx={50} cy={54} rx={28} ry={32} fill={PALETTE.skin2} />
      {/* Styled hair - shoulder length with volume */}
      <path d="M22,50 Q24,18 50,16 Q76,18 78,50 Q82,62 80,82 Q68,76 50,78 Q32,76 20,82 Q18,62 22,50Z" fill={PALETTE.hair3} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={50} cy={54} rx={28} ry={32} fill={PALETTE.skin2} stroke="none"/>
      {/* Eyebrows */}
      <path d="M34,43 Q39,40 44,42" fill="none" stroke={PALETTE.outline} strokeWidth="2" strokeLinecap="round"/>
      <path d="M56,42 Q61,40 66,43" fill="none" stroke={PALETTE.outline} strokeWidth="2" strokeLinecap="round"/>
      <Eye cx={39} cy={51} /> <Eye cx={61} cy={51} />
      <ellipse cx={50} cy={61} rx="4" ry="5" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <path d="M38,71 Q50,79 62,71" fill="#e8899a" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M38,71 Q50,69 62,71" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={22} cy={57} rx="5" ry="7" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={78} cy={57} rx="5" ry="7" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Earring */}
      <circle cx={22} cy={66} r="3" fill="#f1c40f" stroke={PALETTE.outline} strokeWidth="1"/>
      <circle cx={78} cy={66} r="3" fill="#f1c40f" stroke={PALETTE.outline} strokeWidth="1"/>
    </g>
  );
}

function WomanOlder() {
  return (
    <g>
      {/* Smart jacket */}
      <path d="M14,115 Q27,90 50,86 Q73,90 86,115 L86,130 L14,130Z" fill="#2980b9" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M42,86 L50,100 L58,86" fill="#ecf0f1" stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Brooch */}
      <circle cx={50} cy={96} r="5" fill="#f1c40f" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Neck cx={50} y={74} fill={PALETTE.skin1} />
      <Face cx={50} cy={54} rx={28} ry={33} fill={PALETTE.skin1} />
      {/* White short hair */}
      <path d="M22,50 Q24,20 50,18 Q76,20 78,50 Q74,34 60,30 Q50,28 40,30 Q26,34 22,50Z" fill="#e8e8e8" stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Glasses */}
      <rect x={32} y={46} width={15} height={12} rx="4" fill="none" stroke={PALETTE.outline} strokeWidth="2"/>
      <rect x={53} y={46} width={15} height={12} rx="4" fill="none" stroke={PALETTE.outline} strokeWidth="2"/>
      <line x1={47} y1={52} x2={53} y2={52} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <line x1={32} y1={52} x2={27} y2={55} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <line x1={68} y1={52} x2={73} y2={55} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Eye cx={39.5} cy={52} /> <Eye cx={60.5} cy={52} />
      <path d="M47,62 Q50,68 53,62" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Smile x1={37} y1={72} x2={63} y2={72} cpx={50} cpy={79} />
      {/* Smile lines */}
      <path d="M30,66 Q28,72 31,76" fill="none" stroke={PALETTE.outline} strokeWidth="1" opacity="0.4"/>
      <path d="M70,66 Q72,72 69,76" fill="none" stroke={PALETTE.outline} strokeWidth="1" opacity="0.4"/>
      <ellipse cx={22} cy={57} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={78} cy={57} rx="5" ry="7" fill={PALETTE.skin1} stroke={PALETTE.outline} strokeWidth="1.5"/>
    </g>
  );
}

function PersonAthletic() {
  return (
    <g>
      {/* Jersey */}
      <path d="M12,115 Q26,86 50,82 Q74,86 88,115 L88,130 L12,130Z" fill="#e74c3c" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M35,90 L50,82 L65,90" fill="#c0392b" stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Number */}
      <text x={50} y={118} textAnchor="middle" fontSize="14" fontWeight="bold" fill="white" fontFamily="serif">23</text>
      <Neck cx={50} y={72} fill={PALETTE.skin3} />
      <Face cx={50} cy={52} rx={28} ry={31} fill={PALETTE.skin3} />
      {/* Short close-cropped hair */}
      <path d="M22,48 Q24,20 50,18 Q76,20 78,48 Q74,34 50,32 Q26,34 22,48Z" fill={PALETTE.hair5} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <Eye cx={39} cy={51} /> <Eye cx={61} cy={51} />
      {/* Strong jaw/nose */}
      <path d="M46,59 L50,68 L54,59" fill="none" stroke={PALETTE.outline} strokeWidth="2"/>
      <Smile x1={38} y1={72} x2={62} y2={72} cpx={50} cpy={80} />
      <ellipse cx={22} cy={55} rx="5.5" ry="7" fill={PALETTE.skin3} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={78} cy={55} rx="5.5" ry="7" fill={PALETTE.skin3} stroke={PALETTE.outline} strokeWidth="1.5"/>
    </g>
  );
}

function PersonGlamorous() {
  return (
    <g>
      {/* Glamorous top */}
      <path d="M16,115 Q28,86 50,82 Q72,86 84,115 L84,130 L16,130Z" fill="#1a1a2e" stroke={PALETTE.outline} strokeWidth="2"/>
      {/* Sparkles on outfit */}
      {[[30,110],[50,105],[70,110],[40,120],[60,120]].map(([x,y],i) => (
        <text key={i} x={x} y={y} fontSize="10" fill="#f1c40f">✦</text>
      ))}
      {/* V-neck */}
      <path d="M40,82 Q50,96 60,82" fill="none" stroke="#f1c40f" strokeWidth="2"/>
      <Neck cx={50} y={70} fill={PALETTE.skin2} />
      <Face cx={50} cy={50} rx={26} ry={30} fill={PALETTE.skin2} />
      {/* Big glamorous hair */}
      <path d="M18,46 Q16,10 50,8 Q84,10 82,46 Q88,58 84,82 Q70,72 50,74 Q30,72 16,82 Q12,58 18,46Z" fill={PALETTE.hair1} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={50} cy={50} rx={26} ry={30} fill={PALETTE.skin2} stroke="none"/>
      {/* Bold makeup */}
      <path d="M32,39 Q38,36 44,38" fill="none" stroke={PALETTE.outline} strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M56,38 Q62,36 68,39" fill="none" stroke={PALETTE.outline} strokeWidth="2.5" strokeLinecap="round"/>
      <Eye cx={38} cy={48} /> <Eye cx={62} cy={48} />
      {/* Lashes */}
      {[[-4,-4],[-2,-5],[0,-5],[2,-5],[4,-4]].map(([dx,dy],i) => (
        <line key={i} x1={38+dx} y1={44} x2={38+dx*1.3} y2={44+dy} stroke={PALETTE.outline} strokeWidth="1.5"/>
      ))}
      {[[-4,-4],[-2,-5],[0,-5],[2,-5],[4,-4]].map(([dx,dy],i) => (
        <line key={i} x1={62+dx} y1={44} x2={62+dx*1.3} y2={44+dy} stroke={PALETTE.outline} strokeWidth="1.5"/>
      ))}
      <path d="M47,57 Q50,62 53,57" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <path d="M38,67 Q50,75 62,67" fill="#c0392b" stroke={PALETTE.outline} strokeWidth="2"/>
      <path d="M38,67 Q50,65 62,67" fill="none" stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={24} cy={52} rx="5" ry="7" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      <ellipse cx={76} cy={52} rx="5" ry="7" fill={PALETTE.skin2} stroke={PALETTE.outline} strokeWidth="1.5"/>
      {/* Hoop earrings */}
      <circle cx={24} cy={62} r="5" fill="none" stroke="#f1c40f" strokeWidth="2"/>
      <circle cx={76} cy={62} r="5" fill="none" stroke="#f1c40f" strokeWidth="2"/>
    </g>
  );
}

const AVATAR_COMPONENTS = {
  man_young: ManYoung,
  man_middle: ManMiddle,
  man_older: ManOlder,
  woman_young: WomanYoung,
  woman_middle: WomanMiddle,
  woman_older: WomanOlder,
  person_athletic: PersonAthletic,
  person_glamorous: PersonGlamorous,
};

export default function CelebAvatar({ avatarType, size = 100 }) {
  const AvatarComp = AVATAR_COMPONENTS[avatarType] || ManMiddle;
  return (
    <svg
      viewBox="0 0 100 130"
      width={size}
      height={size * 1.3}
      style={{ display: 'block', margin: '0 auto' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Background card */}
      <rect width="100" height="130" fill={PALETTE.bg} rx="4"/>
      {/* Sketch lines for retro feel */}
      <rect width="100" height="130" fill="none" rx="4" stroke={PALETTE.outline} strokeWidth="1" opacity="0.3"/>
      <AvatarComp />
    </svg>
  );
}
