// Drawn assets. Period clothes and objects only: no faces anywhere.

const S48 = (inner) => `<svg viewBox="0 0 48 48" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const S24 = (inner) => `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

export const EMBLEMS = {
  wagonmaster: S48('<path d="M4 31.5c0-2.6 9-4.6 20-4.6s20 2 20 4.6-9 4.6-20 4.6S4 34.1 4 31.5z"/><path d="M14 28.4c0-8.2 3.2-13.4 10-13.4s10 5.2 10 13.4c-3.1 1.1-6.8 1.7-10 1.7s-6.9-.6-10-1.7z"/><path d="M14.6 25.4c3 .9 6.3 1.4 9.4 1.4s6.4-.5 9.4-1.4v2.3c-3 .9-6.3 1.4-9.4 1.4s-6.4-.5-9.4-1.4z" opacity=".4"/>'),
  judge: S48('<g transform="rotate(-38 24 22)"><rect x="12" y="8" width="24" height="10" rx="2.5"/><rect x="21.6" y="17" width="4.8" height="22" rx="2"/></g><rect x="7" y="38" width="22" height="4.5" rx="1.6"/>'),
  heir: S48('<rect x="15" y="7" width="18" height="25" rx="2"/><path d="M7 34.3c0-2.1 7.6-3.8 17-3.8s17 1.7 17 3.8-7.6 3.8-17 3.8-17-1.7-17-3.8z"/><rect x="15" y="25" width="18" height="3.6" opacity=".4"/>'),
  preacher: S48('<path d="M5 29.5c0-2.2 8.5-4 19-4s19 1.8 19 4-8.5 4-19 4-19-1.8-19-4z"/><path d="M14.5 26.6v-8.4c0-1.7 4.3-2.8 9.5-2.8s9.5 1.1 9.5 2.8v8.4c-3 .9-6.3 1.3-9.5 1.3s-6.5-.4-9.5-1.3z"/><rect x="17" y="36" width="14" height="7.5" rx="1.2" opacity=".55"/>'),
  fiddler: S48('<path d="M24 19.5c-4.3 0-7.4 2.6-7.4 6.2 0 2.1 1.2 3.5 2.4 4.4-1.7 1.1-2.9 2.9-2.9 5.1 0 4.1 3.5 6.9 7.9 6.9s7.9-2.8 7.9-6.9c0-2.2-1.2-4-2.9-5.1 1.2-.9 2.4-2.3 2.4-4.4 0-3.6-3.1-6.2-7.4-6.2z"/><rect x="22.8" y="4" width="2.4" height="17" rx="1"/><circle cx="24" cy="5" r="2.4"/><rect x="21" y="34.5" width="6" height="1.6" rx=".8" opacity=".35"/>'),
  printer: S48('<path d="M7 27.5c3.2-6.6 9.6-10 17-10s13.8 3.4 17 10c-5.1-2.6-10.6-3.7-17-3.7S12.1 24.9 7 27.5z"/><path d="M9.5 28.6c4.2-1.7 9.3-2.6 14.5-2.6s10.3.9 14.5 2.6c-1.2 4.4-6.6 7.6-14.5 7.6S10.7 33 9.5 28.6z" opacity=".65"/>'),
  postmaster: S48('<path fill-rule="evenodd" d="M9 13h30a2.2 2.2 0 0 1 2.2 2.2v18.6A2.2 2.2 0 0 1 39 36H9a2.2 2.2 0 0 1-2.2-2.2V15.2A2.2 2.2 0 0 1 9 13zm1.6 3L24 26.1 37.4 16z"/>'),
  furtrader: S48('<path d="M10.5 30.5c0-9.4 6-15.5 13.5-15.5s13.5 6.1 13.5 15.5z"/><rect x="8.5" y="29.5" width="31" height="5.2" rx="2.6" opacity=".7"/><path d="M36.5 31.5c4.3 1.2 6.6 4.4 6.4 8.6-2.1-1.2-4.3-1.7-6.4-1.6z"/>'),
  gambler: S48('<path fill-rule="evenodd" d="M15 7h18a3 3 0 0 1 3 3v28a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3zm9 9.5c-3.1 4-7 6.5-7 9.9a3.5 3.5 0 0 0 5.9 2.5L22 33.5h4l-.9-4.6a3.5 3.5 0 0 0 5.9-2.5c0-3.4-3.9-5.9-7-9.9z"/>'),
  schoolmarm: S48('<path d="M9.5 31c0-10.5 6.4-18.5 15.5-18.5 8.3 0 13.5 6.2 13.5 13.6 0 3.1-1 5.2-2.1 6.4-1-6.6-5.3-11.6-11.6-11.6-7.4 0-11.4 5.3-11.4 11.6v2.1z"/><path d="M17.2 33.2l-3.4 9.3h3.1l2.6-8.4zM30.8 33.2l3.4 9.3h-3.1l-2.6-8.4z"/>'),
  surveyor: S48('<path fill-rule="evenodd" d="M24 5.5a18.5 18.5 0 1 1 0 37 18.5 18.5 0 0 1 0-37zm0 4a14.5 14.5 0 1 0 0 29 14.5 14.5 0 0 0 0-29z"/><path d="M24 12.5l4.2 11.5L24 35.5 19.8 24z"/>'),
  doctor: S48('<path d="M18 14.5a6 6 0 0 1 12 0v2.2h-3v-2.2a3 3 0 0 0-6 0v2.2h-3z"/><path fill-rule="evenodd" d="M9 17.5h30a3 3 0 0 1 3 3v15a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4v-15a3 3 0 0 1 3-3zm13.4 6v3.6H18.8v3.2h3.6v3.6h3.2v-3.6h3.6v-3.2h-3.6v-3.6z"/>'),
};

export const RES_ICON = {
  rations: S24('<path d="M3.5 12.6c0-4.3 3.8-7.6 8.5-7.6s8.5 3.3 8.5 7.6V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M8 8.6l1.4 3.2M12 7.8v3.6M16 8.6l-1.4 3.2" stroke="#11142b" stroke-width="1.4" stroke-linecap="round"/>'),
  water: S24('<path d="M12 2.8c3.2 4.6 6.4 8 6.4 11.6a6.4 6.4 0 0 1-12.8 0c0-3.6 3.2-7 6.4-11.6z"/>'),
  timber: S24('<rect x="2.5" y="6.5" width="19" height="5" rx="2.5"/><rect x="4.5" y="12.5" width="17" height="5" rx="2.5"/><circle cx="19" cy="9" r="1.2" fill="#11142b"/><circle cx="19" cy="15" r="1.2" fill="#11142b"/>'),
};

export const ICON = {
  wagon: '<svg viewBox="0 0 32 22" fill="currentColor"><path d="M4 12c0-6 5-10 12-10s12 4 12 10z"/><rect x="2" y="12" width="28" height="4" rx="1"/><circle cx="8" cy="18.5" r="3"/><circle cx="24" cy="18.5" r="3"/></svg>',
  crown: S24('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>'),
  crowd: S24('<circle cx="6" cy="9" r="2.6"/><circle cx="12" cy="7.5" r="2.8"/><circle cx="18" cy="9" r="2.6"/><path d="M1.8 18c.4-3 2.2-5 4.2-5s3.8 2 4.2 5zM7.6 17.5c.5-3.6 2.4-6 4.4-6s3.9 2.4 4.4 6zM13.8 18c.4-3 2.2-5 4.2-5s3.8 2 4.2 5z"/>'),
  letter: S24('<path fill-rule="evenodd" d="M4 6h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 18H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 6zm1 2l7 5 7-5z"/>'),
  scale: S24('<path d="M11.2 3h1.6v16h4v2H7.2v-2h4z"/><path d="M4 7h16v1.6H4z"/><path d="M6 9l-3 6h6zM18 9l-3 6h6z" opacity=".75"/>'),
  hush: S24('<path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16h-9l-5 4v-4H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 5z" opacity=".55"/><path d="M4 20L20 2" stroke="currentColor" stroke-width="2"/>'),
  standin: S24('<rect x="5" y="8" width="14" height="11" rx="2.5"/><rect x="11" y="3.5" width="2" height="4.5"/><circle cx="12" cy="3" r="1.5"/>'),
  heat: S24('<path fill-rule="evenodd" d="M12 2.5a3 3 0 0 1 3 3v8.3a5 5 0 1 1-6 0V5.5a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v9.3l-.4.3a3 3 0 1 0 2.8 0l-.4-.3V5.5a1 1 0 0 0-1-1z"/><circle cx="12" cy="17.8" r="2"/><rect x="11.2" y="9" width="1.6" height="8" rx=".8"/>'),
  lantern: S24('<rect x="9" y="2" width="6" height="2" rx="1"/><path d="M7 6h10l-1 13H8z" opacity=".55"/><path d="M12 9c1.5 2 2.2 3.3 2.2 4.6a2.2 2.2 0 0 1-4.4 0C9.8 12.3 10.5 11 12 9z"/><rect x="6" y="19" width="12" height="2.5" rx="1"/>'),
  vouch: S24('<path d="M2 12l5-5 4 3 3-3 3 1 5 4-4 4-3-1-3 3-4-2z"/>'),
  eye: S24('<path fill-rule="evenodd" d="M12 6c5 0 8.5 4 9.5 6-1 2-4.5 6-9.5 6S3.5 14 2.5 12C3.5 10 7 6 12 6zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>'),
  still: S24('<circle cx="12" cy="12" r="3"/><path fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" opacity=".5"/>'),
  forage: S24('<path d="M5 20c0-6 3-11 7-14 4 3 7 8 7 14z" opacity=".55"/><path d="M11.2 9h1.6v12h-1.6z"/>'),
  give: S24('<path d="M3 13l4-3h6a2 2 0 0 1 0 4H9.5M7 10V8.5A1.5 1.5 0 0 1 8.5 7H9"/><path d="M3 13v6h3l4-2h6l5-4-1.5-1.5L15 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="6" r="3"/>'),
  cache: S24('<path d="M4 9h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M3 6h18v3H3z" opacity=".6"/>'),
  accuse: S24('<path d="M3 11h12l-3-3 1.4-1.4L19 12l-5.6 5.4L12 16l3-3H3z"/><circle cx="20.5" cy="12" r="1.8"/>'),
  line: S24('<path d="M3 11h18v2H3z"/><path d="M5 6h2v4H5zM5 14h2v4H5zM17 6h2v4h-2zM17 14h2v4h-2z" opacity=".5"/>'),
  sacrifice: S24('<path d="M12 21C6 16 3 12.5 3 9a4.5 4.5 0 0 1 9-1 4.5 4.5 0 0 1 9 1c0 3.5-3 7-9 12z" opacity=".85"/>'),
  fire: S24('<path d="M12 2c1.5 3.5 5.5 6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.5 1.3-4.2 2.6-5.6.2 1.8 1 3 2.3 3.6C11 8.4 11.2 5 12 2z"/>'),
  take: S24('<path d="M5 10h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" opacity=".5"/><path d="M11 3h2v9l3-3 1.4 1.4L12 15.8 6.6 10.4 8 9l3 3z"/>'),
  step: S24('<circle cx="12" cy="5" r="2.5"/><path d="M9 9h6l1 6h-2l-1 6h-2l-1-6H8z"/>'),
  word: S24('<path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16h-9l-5 4v-4H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 5z"/>'),
  claim: S24('<path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16h-9l-5 4v-4H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 5z" opacity=".55"/><path d="M10.5 13.2l-2.7-2.7 1.1-1.1 1.6 1.6 4.6-4.6 1.1 1.1z"/>'),
  mute: S24('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2"/>'),
  sound: S24('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  book: S24('<path d="M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5z"/>'),
};

export const CAPYBARA = '<svg viewBox="0 0 42 28" fill="currentColor"><path d="M5 14.5c0-5.2 6.2-8.3 14.5-8.3 6.2 0 10.4 1.6 13.4 4.1 2.1.2 4.2 1.6 5.7 3.6 1 1.4.6 3.1-1 3.6l-3.1.8c-1.6 3.1-5.2 5.4-11.4 5.4H11.4C7.2 23.7 5 19.9 5 14.5z"/><rect x="9.6" y="20.5" width="3.6" height="6.2" rx="1.6"/><rect x="25.2" y="20.5" width="3.6" height="6.2" rx="1.6"/><path d="M29.4 6.6c.5-1.9 2.1-2.7 3.1-2.1.6.4.5 1.5-.2 2.4z"/></svg>';

export const FLAME = '<svg viewBox="0 0 30 40" fill="none"><rect x="10" y="1" width="10" height="3" rx="1.5" fill="currentColor"/><path d="M6 6h18l-2 26H8z" stroke="currentColor" stroke-width="1.6"/><path d="M15 13c2.6 3.4 3.8 5.6 3.8 7.9a3.8 3.8 0 0 1-7.6 0c0-2.3 1.2-4.5 3.8-7.9z" fill="currentColor" class="fl"/><rect x="5" y="32" width="20" height="4" rx="1.5" fill="currentColor"/></svg>';

export function emblem(characterId) {
  return EMBLEMS[characterId] || S48('<circle cx="24" cy="24" r="10" opacity=".5"/>');
}
