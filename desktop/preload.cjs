// Jembatan kecil antara aplikasi web dan sistem berkas, hanya untuk berkas proyek .fs:
// supaya Save (⌘S / Shift+S) menimpa berkas yang sedang dibuka, bukan mengunduh salinan baru.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fontseruDesktop', {
  /** Path asli berkas yang dipilih lewat <input type="file"> ('' kalau tidak ada). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  /** Tulis ulang berkas proyek yang sudah dibuka/disimpan sebelumnya. */
  saveProject: (filePath, text) => ipcRenderer.invoke('fontseru:save-project', filePath, text),
  /** Dialog Save As bawaan sistem; mengembalikan path tersimpan atau null kalau dibatalkan. */
  saveProjectAs: (suggestedName, text, currentPath) =>
    ipcRenderer.invoke('fontseru:save-project-as', suggestedName, text, currentPath || ''),
});
