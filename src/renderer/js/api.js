'use strict';
/* 彩排 · API 层：宿主桥（Electron preload / Web 垫片）与高频辅助 */
(() => {
  const HB = (window.HB = window.HB || {});
  HB.H = window.habitat;

  /** 拉取证据图片为 data URL（原图 thumb=false / 缩略图 thumb=true）；失败返回 null */
  async function evidenceImage(id, evidenceId, thumb) {
    try {
      const r = await HB.H.evidence.media({ id, evidenceId, thumb });
      return r && r.dataB64 ? `data:${r.mime || 'image/png'};base64,${r.dataB64}` : null;
    } catch { return null; }
  }

  HB.api = { evidenceImage };
})();
