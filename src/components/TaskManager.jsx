import { useState, useRef, useEffect } from 'react';

const TASK_COLORS = [
    '#00bcd4', '#ff9800', '#9c27b0', '#4caf50',
    '#f44336', '#2196f3', '#e91e63', '#009688',
];

const parseInterval = (str) => {
    const s = (str || 'T#10ms').toUpperCase().replace(/^T#|^TIME#/, '');
    if (s.endsWith('MS')) return { value: parseFloat(s), unit: 'ms' };
    if (s.endsWith('US')) return { value: parseFloat(s), unit: 'us' };
    if (s.endsWith('S')) return { value: parseFloat(s), unit: 's' };
    return { value: 10, unit: 'ms' };
};

const fmtInterval = (value, unit) => `T#${value}${unit}`;

const fmtExecUs = (us) => us >= 1000 ? `${(us / 1000).toFixed(1)}ms` : `${us}µs`;

export default function TaskManager({
    taskConfig, onTaskConfigChange,
    programs = [], isRunning = false, liveVariables = null,
}) {
    const tasks = taskConfig?.tasks || [];
    const [editingId, setEditingId] = useState(null);
    const [nameInput, setNameInput] = useState('');
    const [openDropdown, setOpenDropdown] = useState(null);
    const nameRef = useRef(null);

    useEffect(() => { if (editingId) nameRef.current?.select(); }, [editingId]);
    useEffect(() => {
        const close = () => setOpenDropdown(null);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, []);

    const update = (newTasks) => onTaskConfigChange({ ...(taskConfig || {}), tasks: newTasks });

    const assignedSet = new Map();
    tasks.forEach(t => t.programs.forEach(p => assignedSet.set(p.program, t.id)));
    const unassigned = programs.filter(p => !assignedSet.has(p.name));

    const addTask = () => {
        const id = `task_${Date.now()}`;
        update([...tasks, { id, name: `Task${tasks.length + 1}`, interval: 'T#10ms', programs: [] }]);
    };

    const deleteTask = (id) => update(tasks.filter(t => t.id !== id));

    const commitName = (id) => {
        if (nameInput.trim()) update(tasks.map(t => t.id === id ? { ...t, name: nameInput.trim() } : t));
        setEditingId(null);
    };

    const setInterval_ = (id, value, unit) => {
        const cur = parseInterval(tasks.find(t => t.id === id)?.interval);
        const v = value !== undefined ? value : cur.value;
        const u = unit !== undefined ? unit : cur.unit;
        update(tasks.map(t => t.id === id ? { ...t, interval: fmtInterval(v, u) } : t));
    };

    const addProgram = (taskId, progName) => {
        setOpenDropdown(null);
        update(tasks.map(t => {
            if (t.id !== taskId) return t;
            return { ...t, programs: [...t.programs, { program: progName, priority: t.programs.length }] };
        }));
    };

    const removeProgram = (taskId, progName) => {
        update(tasks.map(t => {
            if (t.id !== taskId) return t;
            return {
                ...t, programs: t.programs
                    .filter(p => p.program !== progName)
                    .sort((a, b) => a.priority - b.priority)
                    .map((p, i) => ({ ...p, priority: i })),
            };
        }));
    };

    const moveProgram = (taskId, progName, dir) => {
        update(tasks.map(t => {
            if (t.id !== taskId) return t;
            const sorted = [...t.programs].sort((a, b) => a.priority - b.priority);
            const idx = sorted.findIndex(p => p.program === progName);
            const to = idx + dir;
            if (to < 0 || to >= sorted.length) return t;
            [sorted[idx], sorted[to]] = [sorted[to], sorted[idx]];
            return { ...t, programs: sorted.map((p, i) => ({ ...p, priority: i })) };
        }));
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1e1e1e', overflow: 'hidden', fontFamily: "'Segoe UI', system-ui, sans-serif" }}>

            {/* ── Header ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: '#252526', borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16 }}>⏱</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#bbb', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Task Manager</span>
                </div>
                <button
                    onClick={addTask}
                    disabled={isRunning}
                    style={{
                        padding: '6px 14px', background: isRunning ? '#333' : '#007acc',
                        border: 'none', borderRadius: 4, color: isRunning ? '#555' : '#fff',
                        fontSize: 12, fontWeight: 600, cursor: isRunning ? 'not-allowed' : 'pointer',
                        letterSpacing: '0.03em', transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { if (!isRunning) e.currentTarget.style.background = '#1a8ad4'; }}
                    onMouseLeave={e => { if (!isRunning) e.currentTarget.style.background = '#007acc'; }}
                >
                    + New Task
                </button>
            </div>

            {/* ── Body ── */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>

                {tasks.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '60px 20px', color: '#444', fontSize: 13, fontStyle: 'italic' }}>
                        No tasks yet.&nbsp;
                        <span style={{ color: '#007acc', cursor: 'pointer', textDecoration: 'underline' }} onClick={addTask}>
                            Create your first task
                        </span>
                    </div>
                )}

                {tasks.map((task, ti) => {
                    const color = TASK_COLORS[ti % TASK_COLORS.length];
                    const iv = parseInterval(task.interval);
                    const sorted = [...task.programs].sort((a, b) => a.priority - b.priority);
                    const available = programs.filter(p => !task.programs.some(tp => tp.program === p.name));
                    const ivUs = iv.unit === 'us' ? iv.value : iv.unit === 'ms' ? iv.value * 1000 : iv.value * 1_000_000;

                    return (
                        <div key={task.id} style={{ background: '#252526', borderRadius: 7, borderLeft: `3px solid ${color}`, boxShadow: '0 1px 6px rgba(0,0,0,0.3)' }}>

                            {/* Task header */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #2a2a2a' }}>
                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 6px ${color}88` }} />

                                {editingId === task.id ? (
                                    <input
                                        ref={nameRef}
                                        value={nameInput}
                                        onChange={e => setNameInput(e.target.value)}
                                        onBlur={() => commitName(task.id)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') commitName(task.id);
                                            if (e.key === 'Escape') setEditingId(null);
                                        }}
                                        style={{ flex: 1, background: '#1e1e1e', border: `1px solid ${color}88`, borderRadius: 3, color: '#ddd', fontSize: 13, fontWeight: 600, padding: '2px 8px', outline: 'none' }}
                                    />
                                ) : (
                                    <span
                                        onDoubleClick={() => { if (!isRunning) { setEditingId(task.id); setNameInput(task.name); } }}
                                        title="Double-click to rename"
                                        style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#ddd', cursor: isRunning ? 'default' : 'text', userSelect: 'none' }}
                                    >
                                        {task.name}
                                    </span>
                                )}

                                {/* Interval */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                    <span style={{ fontSize: 10, color: '#666', marginRight: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Interval</span>
                                    <input
                                        type="number" min="1"
                                        value={iv.value}
                                        disabled={isRunning}
                                        onChange={e => setInterval_(task.id, parseFloat(e.target.value) || 1)}
                                        style={{ width: 52, background: '#1e1e1e', border: '1px solid #3a3a3a', borderRadius: 3, color: '#ccc', fontSize: 12, padding: '3px 6px', textAlign: 'right', outline: 'none', MozAppearance: 'textfield' }}
                                    />
                                    <select
                                        value={iv.unit}
                                        disabled={isRunning}
                                        onChange={e => setInterval_(task.id, undefined, e.target.value)}
                                        style={{ background: '#1e1e1e', border: '1px solid #3a3a3a', borderRadius: 3, color: '#ccc', fontSize: 12, padding: '3px 4px', outline: 'none', cursor: 'pointer' }}
                                    >
                                        <option value="us">µs</option>
                                        <option value="ms">ms</option>
                                        <option value="s">s</option>
                                    </select>
                                </div>

                                <button
                                    onClick={() => !isRunning && deleteTask(task.id)}
                                    disabled={isRunning}
                                    title="Delete task"
                                    style={{ background: 'none', border: 'none', color: '#555', cursor: isRunning ? 'not-allowed' : 'pointer', fontSize: 15, padding: '0 4px', lineHeight: 1, borderRadius: 3 }}
                                    onMouseEnter={e => { if (!isRunning) e.currentTarget.style.color = '#f44747'; }}
                                    onMouseLeave={e => e.currentTarget.style.color = '#555'}
                                >
                                    ✕
                                </button>
                            </div>

                            {/* Program list */}
                            <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 8 }}>
                                {sorted.length === 0 && (
                                    <div style={{ fontSize: 11, color: '#444', fontStyle: 'italic', padding: '4px 2px' }}>No programs assigned to this task</div>
                                )}
                                {sorted.map((p, i) => {
                                    const pName = p.program.replace(/\s+/g, '_');
                                    const execUs = liveVariables?.[`prog____exec_us_${pName}`];
                                    const overrun = execUs != null && execUs > ivUs;
                                    return (
                                        <div key={p.program} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#1e1e1e', borderRadius: 4, borderLeft: `2px solid ${color}30` }}>
                                            {/* Priority badge */}
                                            <div style={{ width: 20, height: 20, borderRadius: '50%', background: color + '18', border: `1px solid ${color}50`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: color, fontWeight: 700, flexShrink: 0 }}>
                                                {i + 1}
                                            </div>
                                            <span style={{ flex: 1, fontSize: 12, color: '#ccc' }}>{p.program}</span>

                                            {/* Live exec time */}
                                            {execUs != null && (
                                                <span style={{ fontSize: 10, color: overrun ? '#f44747' : '#4ec9b0', fontVariantNumeric: 'tabular-nums' }}>
                                                    {fmtExecUs(execUs)}
                                                    {overrun && <span title="Overrun!" style={{ marginLeft: 3 }}>⚠</span>}
                                                </span>
                                            )}

                                            {/* Move priority */}
                                            <button onClick={() => moveProgram(task.id, p.program, -1)} disabled={isRunning || i === 0} title="Higher priority" style={{ background: 'none', border: 'none', color: i === 0 || isRunning ? '#333' : '#666', cursor: i === 0 || isRunning ? 'not-allowed' : 'pointer', fontSize: 11, padding: '0 3px', lineHeight: 1 }}>▲</button>
                                            <button onClick={() => moveProgram(task.id, p.program, 1)} disabled={isRunning || i === sorted.length - 1} title="Lower priority" style={{ background: 'none', border: 'none', color: i === sorted.length - 1 || isRunning ? '#333' : '#666', cursor: i === sorted.length - 1 || isRunning ? 'not-allowed' : 'pointer', fontSize: 11, padding: '0 3px', lineHeight: 1 }}>▼</button>
                                            <button onClick={() => !isRunning && removeProgram(task.id, p.program)} disabled={isRunning} title="Remove from task" style={{ background: 'none', border: 'none', color: '#444', cursor: isRunning ? 'not-allowed' : 'pointer', fontSize: 13, padding: '0 3px', lineHeight: 1, borderRadius: 2 }} onMouseEnter={e => { if (!isRunning) e.currentTarget.style.color = '#f44747'; }} onMouseLeave={e => e.currentTarget.style.color = '#444'}>✕</button>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Add program */}
                            <div style={{ padding: '6px 12px 12px', position: 'relative' }}>
                                <button
                                    disabled={isRunning || available.length === 0}
                                    onClick={(e) => { e.stopPropagation(); setOpenDropdown(openDropdown === task.id ? null : task.id); }}
                                    style={{ fontSize: 11, color: isRunning || available.length === 0 ? '#444' : '#888', background: 'none', border: `1px dashed ${isRunning || available.length === 0 ? '#333' : '#444'}`, borderRadius: 4, padding: '4px 12px', cursor: isRunning || available.length === 0 ? 'not-allowed' : 'pointer', transition: 'all 0.15s' }}
                                    onMouseEnter={e => { if (!isRunning && available.length > 0) { e.currentTarget.style.borderColor = color; e.currentTarget.style.color = color; } }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#888'; }}
                                >
                                    + Assign Program
                                </button>
                                {openDropdown === task.id && (
                                    <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', bottom: '100%', left: 12, background: '#2d2d2d', border: '1px solid #444', borderRadius: 5, zIndex: 200, minWidth: 170, boxShadow: '0 4px 20px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
                                        {available.map(prog => (
                                            <div key={prog.name} onClick={() => addProgram(task.id, prog.name)}
                                                style={{ padding: '8px 14px', fontSize: 12, color: '#ccc', cursor: 'pointer', borderBottom: '1px solid #333', transition: 'background 0.1s' }}
                                                onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
                                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                            >
                                                {prog.name}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}

                {/* Unassigned programs */}
                {programs.length > 0 && (
                    <div style={{ background: '#1a1a2a', border: '1px solid #2a2a3a', borderRadius: 6, padding: '12px 16px' }}>
                        <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>Unassigned Programs</span>
                            {unassigned.length > 0 && <span style={{ background: '#f44336', color: '#fff', borderRadius: 9, padding: '0 5px', fontSize: 9, fontWeight: 700 }}>{unassigned.length}</span>}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {unassigned.length === 0
                                ? <span style={{ fontSize: 11, color: '#3a5a3a', fontStyle: 'italic' }}>✓ All programs assigned</span>
                                : unassigned.map(p => (
                                    <span key={p.name} style={{ padding: '3px 10px', background: '#2a2a2a', borderRadius: 12, fontSize: 11, color: '#888', border: '1px solid #383838' }}>
                                        {p.name}
                                    </span>
                                ))
                            }
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
