import React, { useState, useMemo, useRef } from 'react';
import EtherCATIconSrc from '../assets/icons/ethercat.png';
import { PLC_BLOCKS } from '../utils/plcStandards';
import { LIBRARY_TREE, ETHERCAT_LIBRARY_TREE, GENERIC_FB_DEFS } from '../utils/libraryTree';
import { getBoardLibraryTree } from '../utils/boardLibraryBlocks';
import { getBoardFamily } from '../utils/boardDefinitions';
import DragDropManager from '../utils/DragDropManager';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMPTY_IMG = new Image();
EMPTY_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const generateSTSnippet = (blockType, customData) => {
  if (customData) {
    const inputs = customData.inputs || [];
    const instanceName = `${blockType}0`;
    if (customData.type === 'functionBlocks' || customData.class === 'FunctionBlock' || !customData.returnType) {
      const params = inputs.map(input => `  ${input.name} := ${input.default || ''},`).join('\n');
      return `${instanceName}(\n${params}\n);`;
    }
  }
  const blockConfig = PLC_BLOCKS[blockType];
  if (blockConfig) {
    const inputs = blockConfig.inputs || [];
    const instanceName = `${blockType}0`;
    const params = inputs.map(input => `  ${input.name} := ...`).join(',\n');
    return `${instanceName}(\n${params}\n);`;
  }
  return `${blockType}(...);`;
};

/** Build a flat lookup map blockType → library block data from all XML-loaded categories */
const buildBlockMap = (libraryData) => {
  const map = {};
  for (const cat of libraryData) {
    // Support both flat blocks and subcategory blocks
    const blocks = cat.blocks || [];
    for (const block of blocks) {
      if (block.blockType) map[block.blockType] = block;
    }
  }
  return map;
};

// ─── Ghost HTML builder ────────────────────────────────────────────────────────

const getContactCoilSVG = (type, subType) => {
  const base = type === 'Contact'
    ? `<line x1="0" y1="20" x2="10" y2="20" stroke="white" stroke-width="2"/>
       <line x1="10" y1="5" x2="10" y2="35" stroke="white" stroke-width="2"/>
       <line x1="30" y1="5" x2="30" y2="35" stroke="white" stroke-width="2"/>
       <line x1="30" y1="20" x2="40" y2="20" stroke="white" stroke-width="2"/>`
    : `<line x1="0" y1="20" x2="10" y2="20" stroke="white" stroke-width="2"/>
       <path d="M15,5 Q5,20 15,35" stroke="white" stroke-width="2" fill="none"/>
       <path d="M25,5 Q35,20 25,35" stroke="white" stroke-width="2" fill="none"/>
       <line x1="30" y1="20" x2="40" y2="20" stroke="white" stroke-width="2"/>`;
  const extras = {
    NC:      `<line x1="8" y1="35" x2="32" y2="5" stroke="white" stroke-width="2"/>`,
    Rising:  `<text x="20" y="25" text-anchor="middle" font-size="14" fill="white">P</text>`,
    Falling: `<text x="20" y="25" text-anchor="middle" font-size="14" fill="white">N</text>`,
    Negated: `<line x1="15" y1="30" x2="25" y2="10" stroke="white" stroke-width="2"/>`,
    Set:     `<text x="20" y="25" text-anchor="middle" font-size="12" fill="white">S</text>`,
    Reset:   `<text x="20" y="25" text-anchor="middle" font-size="12" fill="white">R</text>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="27" viewBox="0 0 40 40" style="overflow:visible">${base}${extras[subType] || ''}</svg>`;
};

const buildGhostHTML = (blockType, subType, label, customData) => {
  if (blockType === 'Contact' || blockType === 'Coil') {
    const st = subType || (blockType === 'Contact' ? 'NO' : 'Normal');
    const bg = blockType === 'Contact' ? '#1a6b3a' : '#8b3a0f';
    return `<div style="display:flex;flex-direction:column;align-items:center;padding:8px 12px;gap:4px;background:${bg};border-radius:4px;border:1px solid rgba(255,255,255,0.2)">
      <div style="background:#252526;border:1px solid #444;color:#9cdcfe;padding:1px 8px;border-radius:2px;font-size:11px;min-width:72px;text-align:center">??</div>
      ${getContactCoilSVG(blockType, st)}
    </div>`;
  }

  const inputs  = (customData?.inputs  || []).filter(p => p.name !== 'EN');
  const outputs = (customData?.outputs || []).filter(p => p.name !== 'ENO');

  const inRows  = inputs.map(p  => `<div style="display:flex;align-items:center;gap:4px;height:20px"><div style="width:8px;height:8px;background:#4CAF50;border:1px solid #fff;flex-shrink:0"></div><span style="font-size:10px;font-weight:bold">${p.name}</span></div>`).join('');
  const outRows = outputs.map(p => `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;height:20px"><span style="font-size:10px;font-weight:bold">${p.name}</span><div style="width:8px;height:8px;background:#FF5722;border:1px solid #fff;flex-shrink:0"></div></div>`).join('');

  return `<div style="background:#252526;border:1px solid #666;border-radius:4px;min-width:140px;color:#fff;font-size:11px;overflow:hidden">
    <div style="background:#333;padding:2px 4px;text-align:center;font-size:10px;color:#ccc;border-bottom:1px solid #444">${label}0</div>
    <div style="background:#0d47a1;padding:4px 8px;text-align:center;font-weight:bold">${label}</div>
    <div style="display:flex;justify-content:space-between;padding:8px 4px;gap:16px">
      <div style="display:flex;flex-direction:column;gap:10px">${inRows}</div>
      <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-end">${outRows}</div>
    </div>
  </div>`;
};

// ─── ToolboxItem ──────────────────────────────────────────────────────────────

const ToolboxItem = ({ blockType, subType, label, color, customData }) => {
  const ghostRef = useRef(null);
  const listenerRef = useRef(null);

  const onDragStart = (event) => {
    const isContactOrCoil = blockType === 'Contact' || blockType === 'Coil';
    const nodeType = 'blockNode';

    event.dataTransfer.setData('application/reactflow', nodeType);
    if (blockType) event.dataTransfer.setData('blockType', blockType);
    event.dataTransfer.setData('label', label);
    if (customData) event.dataTransfer.setData('customData', JSON.stringify(customData));
    event.dataTransfer.effectAllowed = 'copyMove';

    let stSnippet;
    if (blockType && !isContactOrCoil) {
      const data = customData || (PLC_BLOCKS[blockType] ? {} : null);
      if (data) {
        stSnippet = generateSTSnippet(blockType, data);
        event.dataTransfer.setData('stSnippet', stSnippet);
      }
    }

    DragDropManager.setDragData({
      type: nodeType,
      blockType,
      label,
      customData,
      stSnippet,
      instanceNamePattern: `${blockType}0`
    });

    // Suppress native browser ghost
    event.dataTransfer.setDragImage(EMPTY_IMG, 0, 0);

    // Create cursor-following ghost element (visual block preview)
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position: fixed;
      pointer-events: none;
      font-family: Consolas, monospace;
      box-shadow: 0 4px 16px rgba(0,0,0,0.7);
      z-index: 99999;
      opacity: 0.85;
      top: -9999px;
      left: -9999px;
    `;
    ghost.innerHTML = buildGhostHTML(blockType, subType, label, customData);
    document.body.appendChild(ghost);
    ghostRef.current = ghost;

    const moveGhost = (e) => {
      if (!ghostRef.current) return;
      ghostRef.current.style.left = `${e.clientX + 12}px`;
      ghostRef.current.style.top  = `${e.clientY - 10}px`;
    };
    document.addEventListener('dragover', moveGhost);
    listenerRef.current = moveGhost;
  };

  const onDragEnd = () => {
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
    if (listenerRef.current) {
      document.removeEventListener('dragover', listenerRef.current);
      listenerRef.current = null;
    }
    DragDropManager.clear();
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        padding: '6px 10px',
        margin: '3px 0 3px 0',
        background: color,
        color: '#fff',
        borderRadius: '4px',
        cursor: 'grab',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid rgba(255,255,255,0.1)',
        userSelect: 'none'
      }}
    >
      <span style={{ fontWeight: 'bold', fontSize: '12px' }}>{label}</span>
    </div>
  );
};

// ─── Toolbox ──────────────────────────────────────────────────────────────────

const CAT_COLOR = '#673ab7';   // standard FB / library blocks
const UD_COLOR = '#007acc';   // user-defined
const CONTACT_COLOR = '#1a6b3a'; // contacts (green)
const COIL_COLOR = '#8b3a0f'; // coils (brown-red)
const BOARD_COLOR = '#00695c'; // board-specific blocks (teal)
const EC_COLOR    = '#1565c0'; // EtherCAT blocks (blue)

const COMM_PROTO_BLOCKS = {
  UART: ['UART_Send', 'UART_Receive'],
  I2C:  ['I2C_WriteRead'],
  SPI:  ['SPI_Transfer'],
};

const Toolbox = ({ userDefinedBlocks = [], libraryData = [], activeFileType, selectedBoard, buses = [], interfaceConfig = {} }) => {
  const hasEtherCAT = buses.some(b => b.type === 'ethercat');
  // expand state: category-level and subcategory-level
  const [expandedCats, setExpandedCats] = useState({});
  const [expandedSubs, setExpandedSubs] = useState({});

  const blockMap = useMemo(() => buildBlockMap(libraryData), [libraryData]);

  const boardTree = useMemo(() => {
    const tree = getBoardLibraryTree(selectedBoard);
    // Append subcategories for each enabled comm protocol
    for (const proto of ['UART', 'I2C', 'SPI']) {
      const ports = interfaceConfig[proto];
      const hasEnabled = ports && Object.values(ports).some(p => p?.enabled);
      if (!hasEnabled) continue;
      const blockTypes = COMM_PROTO_BLOCKS[proto];
      tree.push({
        id: `board_comm_${proto.toLowerCase()}`,
        title: proto,
        items: blockTypes.map(blockType => {
          const def = GENERIC_FB_DEFS[blockType];
          return {
            blockType,
            label: blockType,
            desc: def?.inputs?.find(i => i.name === 'Port_ID')?.desc || '',
            customData: { inputs: def?.inputs || [], outputs: def?.outputs || [], class: def?.class || 'FunctionBlock' },
          };
        }),
      });
    }
    return tree;
  }, [selectedBoard, interfaceConfig]);

  const toggleCat = (id) => setExpandedCats(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleSub = (id) => setExpandedSubs(prev => ({ ...prev, [id]: !prev[id] }));

  /** Resolve a subcategory's items into ToolboxItem props */
  const resolveItems = (sub) => {
    if (sub.items) {
      return sub.items.map(item => {
        const isCC = item.blockType === 'Contact' || item.blockType === 'Coil';
        return {
          blockType: item.blockType,
          subType: item.subType,
          label: item.label,
          desc: item.desc,
          customData: isCC ? { subType: item.subType } : (item.customData || null),
          color: item.blockType === 'Contact' ? CONTACT_COLOR
            : item.blockType === 'Coil' ? COIL_COLOR
              : CAT_COLOR
        };
      });
    }

    if (sub.fromLibrary) {
      return sub.fromLibrary
        .map(bType => {
          const lib = blockMap[bType];
          if (!lib) return null;
          return {
            blockType: lib.blockType,
            label: lib.label,
            desc: lib.desc,
            customData: { inputs: lib.inputs, outputs: lib.outputs, class: lib.class },
            color: CAT_COLOR
          };
        })
        .filter(Boolean);
    }

    return [];
  };

  if (libraryData.length === 0) {
    return (
      <div style={{ padding: '15px', color: '#888', fontSize: '12px' }}>
        Loading library…
      </div>
    );
  }

  return (
    <div style={{ padding: '0 10px', height: '100%', overflowY: 'auto' }}>

      {/* ── Board-specific blocks ── */}
      {boardTree.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div
            onClick={() => toggleCat('board')}
            style={{
              padding: '8px 4px',
              color: '#ccc',
              fontSize: '11px',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              borderBottom: '1px solid #3e3e42',
              marginBottom: 4,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              userSelect: 'none'
            }}
          >
            <span style={{ marginRight: 6, fontSize: 9, opacity: 0.7 }}>
              {expandedCats['board'] ? '▼' : '▶'}
            </span>
            {getBoardFamily(selectedBoard) || 'Board'}
          </div>

          {expandedCats['board'] && (
            <div style={{ paddingLeft: 6 }}>
              {boardTree.map(sub => (
                <div key={sub.id} style={{ marginBottom: 4 }}>
                  <div
                    onClick={() => toggleSub(sub.id)}
                    style={{
                      padding: '5px 4px',
                      color: '#aaa',
                      fontSize: '10px',
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      letterSpacing: '0.3px',
                      borderLeft: '2px solid #00897b',
                      paddingLeft: 8,
                      marginBottom: 3,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      userSelect: 'none'
                    }}
                  >
                    <span style={{ marginRight: 5, fontSize: 8, opacity: 0.7 }}>
                      {expandedSubs[sub.id] ? '▼' : '▶'}
                    </span>
                    {sub.title}
                    <span style={{ marginLeft: 'auto', opacity: 0.45, fontSize: 9 }}>
                      {sub.items.length}
                    </span>
                  </div>

                  {expandedSubs[sub.id] && (
                    <div style={{ paddingLeft: 10 }}>
                      {sub.items.map((item, idx) => (
                        <ToolboxItem
                          key={idx}
                          blockType={item.blockType}
                          label={item.label}
                          desc={item.desc}
                          customData={item.customData}
                          color={BOARD_COLOR}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── EtherCAT Master blocks (only when an EtherCAT bus is present) ── */}
      {hasEtherCAT && (
        <div style={{ marginBottom: 6 }}>
          <div
            onClick={() => toggleCat('ethercat')}
            style={{
              padding: '8px 4px', color: '#ccc', fontSize: '11px',
              fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px',
              borderBottom: '1px solid #3e3e42', marginBottom: 4,
              cursor: 'pointer', display: 'flex', alignItems: 'center', userSelect: 'none'
            }}
          >
            <span style={{ marginRight: 6, fontSize: 9, opacity: 0.7 }}>
              {expandedCats['ethercat'] ? '▼' : '▶'}
            </span>
            <img src={EtherCATIconSrc} height="13" style={{ objectFit: 'contain', verticalAlign: 'middle', marginRight: 5, flexShrink: 0 }} alt="EtherCAT" />
            Master
          </div>

          {expandedCats['ethercat'] && (
            <div style={{ paddingLeft: 6 }}>
              {ETHERCAT_LIBRARY_TREE.map(sub => (
                <div key={sub.id} style={{ marginBottom: 4 }}>
                  {/* Subcategory header */}
                  <div
                    onClick={() => toggleSub(sub.id)}
                    style={{
                      padding: '4px 4px', fontSize: '10px', color: '#aaa',
                      cursor: 'pointer', display: 'flex', alignItems: 'center',
                      userSelect: 'none', letterSpacing: '0.3px',
                    }}
                  >
                    <span style={{ marginRight: 5, fontSize: 8, opacity: 0.6 }}>
                      {expandedSubs[sub.id] !== false ? '▼' : '▶'}
                    </span>
                    {sub.title}
                  </div>

                  {expandedSubs[sub.id] !== false && (
                    <div style={{ paddingLeft: 12 }}>
                      {sub.items.map(item => (
                        <ToolboxItem
                          key={item.blockType}
                          blockType={item.blockType}
                          label={item.label}
                          desc={item.desc}
                          customData={item.customData}
                          color={EC_COLOR}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Standard tree from LIBRARY_TREE ── */}
      {LIBRARY_TREE.map(cat => (
        <div key={cat.id} style={{ marginBottom: 6 }}>

          {/* Category header */}
          <div
            onClick={() => toggleCat(cat.id)}
            style={{
              padding: '8px 4px',
              color: '#ccc',
              fontSize: '11px',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              borderBottom: '1px solid #3e3e42',
              marginBottom: 4,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              userSelect: 'none'
            }}
          >
            <span style={{ marginRight: 6, fontSize: 9, opacity: 0.7 }}>
              {expandedCats[cat.id] ? '▼' : '▶'}
            </span>
            {cat.title}
          </div>

          {expandedCats[cat.id] && (
            <div style={{ paddingLeft: 6 }}>
              {cat.subcategories.map(sub => {
                const items = resolveItems(sub);
                if (items.length === 0) return null;

                return (
                  <div key={sub.id} style={{ marginBottom: 4 }}>

                    {/* Subcategory header */}
                    <div
                      onClick={() => toggleSub(sub.id)}
                      style={{
                        padding: '5px 4px',
                        color: '#aaa',
                        fontSize: '10px',
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: '0.3px',
                        borderLeft: '2px solid #555',
                        paddingLeft: 8,
                        marginBottom: 3,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        userSelect: 'none'
                      }}
                    >
                      <span style={{ marginRight: 5, fontSize: 8, opacity: 0.7 }}>
                        {expandedSubs[sub.id] ? '▼' : '▶'}
                      </span>
                      {sub.title}
                      <span style={{ marginLeft: 'auto', opacity: 0.45, fontSize: 9 }}>
                        {items.length}
                      </span>
                    </div>

                    {expandedSubs[sub.id] && (
                      <div style={{ paddingLeft: 10 }}>
                        {items.map((item, idx) => (
                          <ToolboxItem key={idx} {...item} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {/* ── User-Defined blocks (flat, no subcategories) ── */}
      {userDefinedBlocks && userDefinedBlocks.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div
            onClick={() => toggleCat('user_defined')}
            style={{
              padding: '8px 4px',
              color: '#ccc',
              fontSize: '11px',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              borderBottom: '1px solid #3e3e42',
              marginBottom: 4,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              userSelect: 'none'
            }}
          >
            <span style={{ marginRight: 6, fontSize: 9, opacity: 0.7 }}>
              {expandedCats['user_defined'] ? '▼' : '▶'}
            </span>
            User Defined
          </div>

          {expandedCats['user_defined'] && (
            <div style={{ paddingLeft: 6 }}>
              {userDefinedBlocks.map((b, idx) => (
                <ToolboxItem
                  key={idx}
                  blockType={b.name}
                  label={b.name}
                  desc={b.type === 'functionBlocks' ? 'Block' : 'Function'}
                  customData={{ ...b }}
                  color={UD_COLOR}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Toolbox;
