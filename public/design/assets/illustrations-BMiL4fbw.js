const t=(l,a="0 0 200 200")=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${a}" width="200" height="200">${l}</svg>`,i=[{id:"plant",name:"Tanaman pot",tags:"plant tanaman daun rumah",svg:t(`
      <path d="M100 118 C96 90 92 70 70 52 C92 58 104 80 104 118 Z" fill="#14B87A"/>
      <path d="M102 118 C106 84 122 62 150 56 C128 70 114 92 108 118 Z" fill="#8FDAB2"/>
      <path d="M100 120 C84 104 62 100 44 106 C62 96 90 98 104 118 Z" fill="#4FB585"/>
      <path d="M104 120 C120 104 142 102 158 110 C140 100 114 100 100 118 Z" fill="#14B87A"/>
      <path d="M62 118 H138 L128 176 C127 182 122 186 116 186 H84 C78 186 73 182 72 176 Z" fill="#F2A77A"/>
      <rect x="56" y="112" width="88" height="14" rx="5" fill="#E9936A"/>`)},{id:"mountain",name:"Pegunungan",tags:"gunung alam landscape outdoor",svg:t(`
      <rect x="10" y="30" width="180" height="140" rx="24" fill="#EEF1FF"/>
      <circle cx="140" cy="70" r="18" fill="#F6C58F"/>
      <path d="M10 150 L70 78 L104 118 L128 94 L190 150 V146 C190 159 179 170 166 170 H34 C21 170 10 159 10 146 Z" fill="#8AA2FF"/>
      <path d="M70 78 L84 95 L76 100 L68 92 L58 99 Z" fill="#FFFFFF"/>
      <path d="M10 156 C50 136 90 150 120 140 C150 131 170 140 190 148 V146 C190 159 179 170 166 170 H34 C21 170 10 159 10 146 Z" fill="#2F7BFF"/>`)},{id:"coffee",name:"Kopi hangat",tags:"kopi coffee cafe minuman",svg:t(`
      <path d="M86 40 C78 52 94 58 86 72" fill="none" stroke="#A9C4FF" stroke-width="6" stroke-linecap="round"/>
      <path d="M108 34 C100 48 116 56 108 72" fill="none" stroke="#A9C4FF" stroke-width="6" stroke-linecap="round"/>
      <path d="M52 86 H144 V128 C144 152 124 170 100 170 H96 C72 170 52 152 52 128 Z" fill="#F2A77A"/>
      <path d="M144 96 C168 96 170 132 142 134" fill="none" stroke="#F2A77A" stroke-width="10" stroke-linecap="round"/>
      <rect x="52" y="82" width="92" height="12" rx="6" fill="#8B5E45"/>
      <ellipse cx="98" cy="178" rx="62" ry="8" fill="#E4E4E0"/>`)},{id:"weather",name:"Cerah berawan",tags:"cuaca matahari awan weather sun cloud",svg:t(`
      <circle cx="118" cy="78" r="34" fill="#F6C58F"/>
      <g stroke="#FFC233" stroke-width="7" stroke-linecap="round">
        <path d="M118 24 V34"/><path d="M160 36 L153 43"/><path d="M174 78 H164"/><path d="M76 36 L83 43"/>
      </g>
      <path d="M50 150 C30 150 26 122 46 116 C46 94 74 86 88 102 C98 84 130 88 132 112 C154 110 160 146 136 150 Z" fill="#FFFFFF" stroke="#A9C4FF" stroke-width="4"/>`)},{id:"planet",name:"Planet",tags:"planet luar angkasa space saturnus",svg:t(`
      <circle cx="100" cy="100" r="46" fill="#8AA2FF"/>
      <path d="M68 86 C84 80 104 92 124 84 C132 80 140 84 144 90" fill="none" stroke="#2F7BFF" stroke-width="8" stroke-linecap="round"/>
      <ellipse cx="100" cy="104" rx="84" ry="22" fill="none" stroke="#FF9DB8" stroke-width="8" transform="rotate(-14 100 104)"/>
      <path d="M40 40 L43 48 L51 51 L43 54 L40 62 L37 54 L29 51 L37 48 Z" fill="#FFC233"/>
      <circle cx="160" cy="44" r="4" fill="#FFC233"/><circle cx="36" cy="160" r="3" fill="#A9C4FF"/>`)},{id:"gift",name:"Kado",tags:"hadiah kado gift ulang tahun promo",svg:t(`
      <rect x="44" y="86" width="112" height="84" rx="10" fill="#FF5F5F"/>
      <rect x="36" y="70" width="128" height="26" rx="8" fill="#FF9DB8"/>
      <rect x="92" y="70" width="16" height="100" fill="#FFC233"/>
      <path d="M100 70 C80 40 52 50 62 66 C68 74 88 72 100 70 Z" fill="#FFC233"/>
      <path d="M100 70 C120 40 148 50 138 66 C132 74 112 72 100 70 Z" fill="#FFC233"/>`)},{id:"laptop",name:"Laptop",tags:"laptop kerja komputer work desain",svg:t(`
      <rect x="44" y="52" width="112" height="76" rx="8" fill="#2B2B2E"/>
      <rect x="52" y="60" width="96" height="60" rx="4" fill="#EEF1FF"/>
      <rect x="62" y="72" width="40" height="8" rx="4" fill="#2F7BFF"/>
      <rect x="62" y="86" width="64" height="6" rx="3" fill="#A9C4FF"/>
      <rect x="62" y="98" width="52" height="6" rx="3" fill="#A9C4FF"/>
      <path d="M28 134 H172 L164 146 C162 149 159 150 156 150 H44 C41 150 38 149 36 146 Z" fill="#7A7A80"/>`)},{id:"chat",name:"Percakapan",tags:"chat pesan komunikasi message",svg:t(`
      <path d="M30 50 C30 42 36 36 44 36 H122 C130 36 136 42 136 50 V96 C136 104 130 110 122 110 H70 L46 130 L50 110 H44 C36 110 30 104 30 96 Z" fill="#2F7BFF"/>
      <rect x="48" y="58" width="56" height="8" rx="4" fill="#FFFFFF"/><rect x="48" y="76" width="72" height="8" rx="4" fill="#FFFFFF" opacity="0.7"/>
      <path d="M170 102 C170 94 164 88 156 88 H96 C88 88 82 94 82 102 V136 C82 144 88 150 96 150 H140 L160 166 L156 150 H156 C164 150 170 144 170 136 Z" fill="#B8E4CC"/>
      <circle cx="108" cy="119" r="6" fill="#4FB585"/><circle cx="126" cy="119" r="6" fill="#4FB585"/><circle cx="144" cy="119" r="6" fill="#4FB585"/>`)},{id:"rocket",name:"Roket",tags:"roket startup luncur launch",svg:t(`
      <path d="M100 26 C128 44 136 86 124 126 H76 C64 86 72 44 100 26 Z" fill="#EEF1FF" stroke="#8AA2FF" stroke-width="4"/>
      <circle cx="100" cy="76" r="14" fill="#8AA2FF"/>
      <path d="M76 108 L52 138 L78 132 Z" fill="#FF5F5F"/><path d="M124 108 L148 138 L122 132 Z" fill="#FF5F5F"/>
      <path d="M86 128 H114 C112 148 106 160 100 172 C94 160 88 148 86 128 Z" fill="#FFC233"/>`)},{id:"book",name:"Buku terbuka",tags:"buku belajar baca edukasi book",svg:t(`
      <path d="M100 58 C80 46 52 44 30 50 V150 C52 144 80 146 100 158 Z" fill="#A9C4FF"/>
      <path d="M100 58 C120 46 148 44 170 50 V150 C148 144 120 146 100 158 Z" fill="#EEF1FF" stroke="#A9C4FF" stroke-width="3"/>
      <g stroke="#8AA2FF" stroke-width="4" stroke-linecap="round"><path d="M116 74 H152"/><path d="M116 90 H152"/><path d="M116 106 H142"/></g>
      <path d="M100 58 V158" stroke="#2F7BFF" stroke-width="3"/>`)}];export{i as I};
