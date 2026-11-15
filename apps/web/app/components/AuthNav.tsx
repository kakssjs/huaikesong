'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import RegisterModal from './RegisterModal';

export default function AuthNav() {
  const [modalMode, setModalMode] = useState<'register' | 'login' | null>(null);
  const [user, setUser] = useState<{ id: number; role: string; name: string; companyName?: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/auth/me').then(async res => {
      if (!live) return;
      if (res.ok) {
        const { id, role, name, companyName } = await res.json();
        if (!live) return;
        const current = { id, role, name, companyName };
        setUser(current);
        try { localStorage.setItem('user', JSON.stringify(current)); } catch {}
      } else if (res.status === 401 || res.status === 404) {
        setUser(null);
        try { localStorage.removeItem('user'); } catch {}
      }
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  function handleSuccess(u: { id: number; role: string; name: string; companyName?: string }) {
    setUser(u);
    try { localStorage.setItem('user', JSON.stringify(u)); } catch {}
    setModalMode(null);
    // 同一路由也重新挂载页面，让权限与数据按新的服务端会话读取。
    window.location.assign(u.role === 'boss' ? '/boss' : u.role === 'company' ? '/contractor' : '/dashboard');
  }

  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('logout failed');
    } catch {
      window.alert('退出失败，请检查网络后重试');
      return;
    }
    setUser(null);
    try { localStorage.removeItem('user'); } catch {}
    window.location.assign('/');
  }

  if (user) {
    const consoleHref = user.role === 'boss' ? '/boss' : user.role === 'company' ? '/contractor' : '/dashboard';
    const consoleLabel = user.role === 'boss' ? '老板控制台' : user.role === 'company' ? '公司后台' : '我的工作台';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {user.role !== 'boss' && <Link href="/messages" className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }}>消息中心</Link>}
        <Link href={consoleHref} className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }}>
          {consoleLabel}
        </Link>
        <span className="tag tag-cyan" style={{ fontSize: 11 }}>
          {user.role === 'boss' ? '平台老板' : user.role === 'company' ? '装潢公司' : '个人用户'}
        </span>
        <span className="user-name">{user.companyName ?? user.name}</span>
        <button onClick={logout} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>退出</button>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <button data-auth="login" onClick={() => setModalMode('login')} className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }}>
          登录
        </button>
        <button data-auth="register" onClick={() => setModalMode('register')} className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }}>
          注册
        </button>
      </div>
      {modalMode && <RegisterModal mode={modalMode} onClose={() => setModalMode(null)} onSuccess={handleSuccess} />}
    </>
  );
}
