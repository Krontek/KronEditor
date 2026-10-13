import React, { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { EMPTY_FORCED } from '../../utils/forcedVars';

// The FORCED set (a Set of live keys) for every live view, provided once by
// App. A context rather than a prop: it reaches the ladder nodes without
// touching RungContainer's node rebuild (src/CLAUDE.md — nothing live may sit in
// mapBlocksToNodes' deps) and it changes rarely, so only its consumers
// re-render when a force is set or released.
export const ForcedContext = createContext(EMPTY_FORCED);
export const useForcedSet = () => useContext(ForcedContext);

// CODESYS-style force marker: a small red-framed "F" next to a value whose
// value is held by a force. Clicking it opens the caller's force dialog
// (which offers Release).
const ForcedMarker = ({ onClick, compact = false, style }) => {
  const { t } = useTranslation();
  const clickable = typeof onClick === 'function';
  return (
    <span
      className="kron-forced-marker"
      title={t('forces.markerTitle')}
      onClick={clickable ? (e) => { e.stopPropagation(); onClick(e); } : undefined}
      onMouseDown={clickable ? (e) => e.stopPropagation() : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        minWidth: compact ? 11 : 14,
        height: compact ? 11 : 14,
        padding: '0 2px',
        marginLeft: 3,
        border: '1.5px solid #ff1744',
        borderRadius: 2,
        background: 'rgba(255,23,68,0.15)',
        color: '#ff5252',
        fontSize: compact ? 8 : 10,
        fontWeight: 800,
        fontFamily: 'Consolas, "Cascadia Code", monospace',
        lineHeight: 1,
        cursor: clickable ? 'pointer' : 'default',
        userSelect: 'none',
        flexShrink: 0,
        verticalAlign: 'middle',
        pointerEvents: 'auto',
        ...style,
      }}
    >
      F
    </span>
  );
};

export default ForcedMarker;
