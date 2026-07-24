import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { formatFileSize, isImageExtension, type AttachmentInfo } from './attachmentsMath';

export function FilesView() {
  const [files, setFiles] = useState<AttachmentInfo[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const list = await window.aetherElectron?.attachments.list();
    setFiles(list ?? []);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    files.forEach((f) => {
      if (isImageExtension(f.name) && !(f.name in thumbnails)) {
        window.aetherElectron?.attachments.thumbnail(f.name).then((dataUrl) => {
          if (dataUrl) setThumbnails((prev) => ({ ...prev, [f.name]: dataUrl }));
        });
      }
    });
  }, [files, thumbnails]);

  const addFile = async () => {
    await window.aetherElectron?.attachments.add();
    refresh();
  };

  const removeFile = async (name: string) => {
    try {
      await window.aetherElectron?.attachments.remove(name);
    } catch {
      // already gone on disk (e.g. removed externally) — fall through to refresh so the UI self-corrects
    } finally {
      refresh();
    }
  };

  const openFile = (name: string) => {
    window.aetherElectron?.attachments.open(name);
  };

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>ATTACHMENTS</div>
        <span onClick={addFile} style={addButtonStyle}>+ ADD FILE</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {files.map((f) => (
          <div key={f.name} style={rowStyle}>
            <span onClick={() => openFile(f.name)} style={thumbStyle}>
              {thumbnails[f.name] ? <img src={thumbnails[f.name]} alt="" style={imgStyle} /> : extBadge(f.name)}
            </span>
            <div onClick={() => openFile(f.name)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
              <div style={nameStyle}>{f.name}</div>
              <div style={sizeStyle}>{formatFileSize(f.size)}</div>
            </div>
            <span onClick={() => removeFile(f.name)} style={deleteStyle}>×</span>
          </div>
        ))}
        {!files.length && <div style={emptyStyle}>no files attached yet — click + ADD FILE to attach a screenshot or document</div>}
      </div>
    </div>
  );
}

function extBadge(name: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(i + 1) : '?').slice(0, 4).toUpperCase();
}

const cardStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const addButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1,
  padding: '7px 14px',
  borderRadius: 7,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
  boxShadow: '0 0 10px rgba(95,220,255,.4)',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 9px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.16)',
  background: 'rgba(6,20,28,.5)',
};
const thumbStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: 'none',
  borderRadius: 6,
  overflow: 'hidden',
  cursor: 'pointer',
  background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
  border: `1px solid ${colors.accentCyanSoft}`,
  display: 'grid',
  placeItems: 'center',
  font: `700 9px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
};
const imgStyle: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };
const nameStyle: CSSProperties = {
  font: `600 12px/1.3 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const sizeStyle: CSSProperties = { font: `400 10px/1.3 ${fonts.mono}`, color: colors.textDim, marginTop: 2 };
const deleteStyle: CSSProperties = {
  flex: 'none',
  cursor: 'pointer',
  font: `700 14px/1 ${fonts.ui}`,
  color: colors.dangerSoft,
  padding: '2px 6px',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
