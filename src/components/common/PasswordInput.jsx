import { useState } from 'react';

/**
 * Password field with a show/hide eye toggle.
 *
 * The `style` prop is applied to the <input> itself, so a call site keeps the
 * exact look it had with a plain `<input type="password">`; the eye button is
 * overlaid on the right edge and the input gets the room for it.
 * Any other prop (onFocus, onBlur, disabled, autoComplete, ...) is forwarded.
 */
const EyeIcon = ({ off }) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
        {off && <line x1="3" y1="21" x2="21" y2="3" />}
    </svg>
);

const PasswordInput = ({
    value,
    onChange,
    placeholder,
    style = {},
    iconColor = '#888',
    showTitle = 'Show password',
    hideTitle = 'Hide password',
    ...rest
}) => {
    const [shown, setShown] = useState(false);
    const label = shown ? hideTitle : showTitle;

    return (
        <div style={{ position: 'relative', width: style.width || '100%' }}>
            <input
                {...rest}
                type={shown ? 'text' : 'password'}
                value={value ?? ''}
                onChange={onChange}
                placeholder={placeholder}
                style={{ ...style, width: '100%', paddingRight: '30px', boxSizing: 'border-box' }}
            />
            <button
                type="button"
                tabIndex={-1}
                title={label}
                aria-label={label}
                onClick={() => setShown(s => !s)}
                style={{
                    position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 'none', padding: '2px', margin: 0,
                    cursor: 'pointer', color: iconColor, lineHeight: 0,
                    display: 'flex', alignItems: 'center',
                }}
            >
                <EyeIcon off={shown} />
            </button>
        </div>
    );
};

export default PasswordInput;
