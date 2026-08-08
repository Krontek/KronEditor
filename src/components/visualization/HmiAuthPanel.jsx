import { useState } from 'react';
import { generateSalt, hashPassword } from '../../services/HmiExportService';
import PasswordInput from '../common/PasswordInput';

const ROLES = [
    { value: 'admin',      label: 'Admin',       desc: 'Full access + user management',        color: '#f14c4c' },
    { value: 'maintainer', label: 'Maintainer',   desc: 'All pages read/write, no user mgmt',   color: '#e5a64a' },
    { value: 'operator',   label: 'Operator',     desc: 'Read + write on operational pages',    color: '#007acc' },
    { value: 'viewer',     label: 'Viewer',       desc: 'Read-only on permitted pages',         color: '#4ec9b0' },
];

const ALL_ROLES = ROLES.map(r => r.value);
const DEFAULT_READ_ROLES  = ALL_ROLES;
const DEFAULT_WRITE_ROLES = ['admin', 'maintainer', 'operator'];

/* ─── Small helpers ──────────────────────────────────────────── */
const Input = ({ value, onChange, type = 'text', placeholder, style = {} }) => {
    const common = {
        value: value ?? '',
        placeholder,
        onChange: e => onChange(e.target.value),
        style: {
            background: '#1a1a1a', border: '1px solid #333', color: '#d4d4d4',
            fontSize: 12, padding: '4px 8px', outline: 'none',
            width: '100%', fontFamily: 'inherit', ...style,
        },
        onFocus: e => e.target.style.borderColor = '#007acc',
        onBlur: e => e.target.style.borderColor = '#333',
    };
    // Passwords get the shared eye toggle; everything else stays a plain input.
    return type === 'password' ? <PasswordInput {...common} iconColor="#555" /> : <input type={type} {...common} />;
};

const RoleTag = ({ role }) => {
    const def = ROLES.find(r => r.value === role);
    return (
        <span style={{
            background: def ? def.color + '22' : '#222',
            color: def ? def.color : '#888',
            border: `1px solid ${def ? def.color + '55' : '#333'}`,
            fontSize: 10, padding: '1px 6px', letterSpacing: '0.05em',
            textTransform: 'uppercase', whiteSpace: 'nowrap',
        }}>
            {def ? def.label : role}
        </span>
    );
};

const RoleCheckboxes = ({ value = [], onChange }) => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ROLES.map(r => (
            <label key={r.value} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11 }}>
                <input
                    type="checkbox"
                    checked={value.includes(r.value)}
                    onChange={e => {
                        const next = e.target.checked
                            ? [...value, r.value]
                            : value.filter(v => v !== r.value);
                        onChange(next);
                    }}
                    style={{ accentColor: r.color }}
                />
                <span style={{ color: r.color }}>{r.label}</span>
            </label>
        ))}
    </div>
);

/* ─── Users Tab ──────────────────────────────────────────────── */
const UsersTab = ({ users, onChange }) => {
    const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' });
    const [err, setErr] = useState('');
    const [adding, setAdding] = useState(false);

    const handleAdd = async () => {
        setErr('');
        if (!newUser.username.trim()) { setErr('Username required'); return; }
        if (!newUser.password) { setErr('Password required'); return; }
        if (users.some(u => u.username === newUser.username.trim())) { setErr('Username already exists'); return; }
        setAdding(true);
        try {
            const salt = generateSalt();
            const passwordHash = await hashPassword(salt, newUser.password);
            const user = {
                id: `u_${Date.now()}`,
                username: newUser.username.trim(),
                role: newUser.role,
                salt,
                passwordHash,
            };
            onChange([...users, user]);
            setNewUser({ username: '', password: '', role: 'operator' });
        } catch (e) {
            setErr('Error: ' + e.message);
        }
        setAdding(false);
    };

    const handleDelete = (id) => onChange(users.filter(u => u.id !== id));

    const handleChangeRole = (id, role) => onChange(users.map(u => u.id === id ? { ...u, role } : u));

    const handleChangePassword = async (id) => {
        const pw = window.prompt('New password:');
        if (!pw) return;
        const user = users.find(u => u.id === id);
        if (!user) return;
        const salt = generateSalt();
        const passwordHash = await hashPassword(salt, pw);
        onChange(users.map(u => u.id === id ? { ...u, salt, passwordHash } : u));
    };

    return (
        <div>
            {/* User list */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
                <thead>
                    <tr style={{ borderBottom: '1px solid #2a2a2a', background: '#1a1a1a' }}>
                        {['Username', 'Role', ''].map(h => (
                            <th key={h} style={{ padding: '5px 10px', textAlign: 'left', fontSize: 10, fontWeight: '600', color: '#555', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {users.length === 0 && (
                        <tr><td colSpan={3} style={{ padding: '10px', color: '#444', fontStyle: 'italic', textAlign: 'center', fontSize: 11 }}>No users defined. Add one below.</td></tr>
                    )}
                    {users.map(u => (
                        <tr key={u.id} style={{ borderBottom: '1px solid #1e1e1e' }}>
                            <td style={{ padding: '5px 10px', color: '#c0c0c0' }}>{u.username}</td>
                            <td style={{ padding: '5px 10px' }}>
                                <select
                                    value={u.role}
                                    onChange={e => handleChangeRole(u.id, e.target.value)}
                                    style={{ background: '#1a1a1a', border: '1px solid #333', color: '#d4d4d4', fontSize: 11, padding: '2px 4px', outline: 'none' }}
                                >
                                    {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                                </select>
                            </td>
                            <td style={{ padding: '5px 10px', display: 'flex', gap: 6 }}>
                                <button
                                    onClick={() => handleChangePassword(u.id)}
                                    title="Change password"
                                    style={{ background: 'transparent', border: '1px solid #333', color: '#888', fontSize: 11, padding: '2px 7px', cursor: 'pointer' }}
                                >🔑</button>
                                <button
                                    onClick={() => handleDelete(u.id)}
                                    title="Delete user"
                                    style={{ background: 'transparent', border: '1px solid #2a1a1a', color: '#8b2020', fontSize: 11, padding: '2px 7px', cursor: 'pointer' }}
                                >✕</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {/* Add user form */}
            <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', padding: '12px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: '600', color: '#555', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Add User</div>
                {err && <div style={{ fontSize: 11, color: '#f14c4c', marginBottom: 8 }}>{err}</div>}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 8, alignItems: 'end' }}>
                    <div>
                        <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>Username</div>
                        <Input value={newUser.username} onChange={v => setNewUser(p => ({ ...p, username: v }))} placeholder="username" />
                    </div>
                    <div>
                        <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>Password</div>
                        <Input type="password" value={newUser.password} onChange={v => setNewUser(p => ({ ...p, password: v }))} placeholder="password" />
                    </div>
                    <div>
                        <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>Role</div>
                        <select
                            value={newUser.role}
                            onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                            style={{ background: '#1a1a1a', border: '1px solid #333', color: '#d4d4d4', fontSize: 12, padding: '4px 6px', outline: 'none' }}
                        >
                            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                    </div>
                    <button
                        onClick={handleAdd}
                        disabled={adding}
                        style={{
                            background: '#007acc', border: 'none', color: '#fff',
                            fontSize: 12, padding: '5px 14px', cursor: adding ? 'not-allowed' : 'pointer',
                            fontWeight: '600', opacity: adding ? 0.6 : 1,
                        }}
                    >
                        {adding ? '…' : 'Add'}
                    </button>
                </div>
            </div>

            {/* Role legend */}
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {ROLES.map(r => (
                    <div key={r.value} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <RoleTag role={r.value} />
                        <span style={{ fontSize: 11, color: '#555' }}>{r.desc}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

/* ─── Permissions Tab ───────────────────────────────────────── */
const PermissionsTab = ({ pages, pagePerms, onChange }) => {
    const update = (pageId, field, value) => {
        const current = pagePerms[pageId] || { readRoles: DEFAULT_READ_ROLES, writeRoles: DEFAULT_WRITE_ROLES };
        onChange({ ...pagePerms, [pageId]: { ...current, [field]: value } });
    };

    return (
        <div>
            <p style={{ fontSize: 11, color: '#555', marginBottom: 14 }}>
                Control which roles can read or write each page.
                Pages without explicit settings use the default: all roles can read, Operator+ can write.
            </p>

            {pages.length === 0 ? (
                <div style={{ color: '#444', fontStyle: 'italic', fontSize: 11, textAlign: 'center', padding: 16 }}>
                    No pages defined yet.
                </div>
            ) : pages.map(pg => {
                const perm = pagePerms[pg.id] || { readRoles: DEFAULT_READ_ROLES, writeRoles: DEFAULT_WRITE_ROLES };
                return (
                    <div key={pg.id} style={{ marginBottom: 14, background: '#1a1a1a', border: '1px solid #2a2a2a', padding: '12px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: '600', color: '#c0c0c0', marginBottom: 10 }}>{pg.name}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 11, color: '#666', width: 60, flexShrink: 0 }}>Read</span>
                                <RoleCheckboxes value={perm.readRoles} onChange={v => update(pg.id, 'readRoles', v)} />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 11, color: '#666', width: 60, flexShrink: 0 }}>Write</span>
                                <RoleCheckboxes value={perm.writeRoles} onChange={v => update(pg.id, 'writeRoles', v)} />
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

/* ─── Main HmiAuthPanel ──────────────────────────────────────── */
const HmiAuthPanel = ({ hmiLayout, onLayoutChange }) => {
    const [tab, setTab] = useState('users');

    const auth = hmiLayout?.auth || { users: [], pagePerms: {} };
    const pages = hmiLayout?.pages || [];

    const setAuth = (newAuth) => {
        onLayoutChange({ ...hmiLayout, auth: newAuth });
    };

    const setUsers = (users) => setAuth({ ...auth, users });
    const setPagePerms = (pagePerms) => setAuth({ ...auth, pagePerms });

    const tabs = [
        { key: 'users', label: 'Users' },
        { key: 'perms', label: 'Page Permissions' },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#141414' }}>
            {/* Tab bar */}
            <div style={{ display: 'flex', background: '#1a1a1a', borderBottom: '1px solid #2a2a2a', padding: '0 12px', flexShrink: 0 }}>
                {tabs.map(t => (
                    <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        style={{
                            background: 'transparent', border: 'none',
                            borderBottom: tab === t.key ? '2px solid #007acc' : '2px solid transparent',
                            color: tab === t.key ? '#e0e0e0' : '#666',
                            fontSize: 11, fontWeight: tab === t.key ? '600' : '400',
                            padding: '6px 14px', cursor: 'pointer',
                            letterSpacing: '0.04em', textTransform: 'uppercase',
                        }}
                    >
                        {t.label}
                        {t.key === 'users' && auth.users.length > 0 && (
                            <span style={{ marginLeft: 6, background: '#2a3a4a', color: '#7eb8f7', fontSize: 10, padding: '0 5px', borderRadius: 2 }}>
                                {auth.users.length}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
                {tab === 'users' && (
                    <UsersTab users={auth.users} onChange={setUsers} />
                )}
                {tab === 'perms' && (
                    <PermissionsTab pages={pages} pagePerms={auth.pagePerms || {}} onChange={setPagePerms} />
                )}
            </div>
        </div>
    );
};

export default HmiAuthPanel;
