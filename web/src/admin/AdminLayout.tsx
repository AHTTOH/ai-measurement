import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { adminApi } from '../api/admin-client';
import { ApiError, errorMessage } from '../api/http';
import '../styles/admin.css';

/** 관리자 화면 틀. 로그인하지 않았으면 로그인 화면으로 보낸다 */
export function AdminLayout(): ReactElement {
  const navigate = useNavigate();
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.me().then(
      (me) => setUsername(me.username),
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) void navigate('/admin/login', { replace: true });
        else setError(errorMessage(e));
      },
    );
  }, [navigate]);

  const logout = async () => {
    await adminApi.logout();
    void navigate('/admin/login');
  };

  if (error !== null) return <p className="alert admin-page">{error}</p>;
  if (username === null) return <p className="muted admin-page">불러오는 중</p>;
  return (
    <div className="admin">
      <header className="admin-header">
        <Link to="/admin" className="admin-brand">
          AI 실무역량 평가 운영
        </Link>
        <span className="muted small">{username}</span>
        <button type="button" className="btn btn-quiet" onClick={() => void logout()}>
          로그아웃
        </button>
      </header>
      <Outlet />
    </div>
  );
}

export function AdminLoginPage(): ReactElement {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await adminApi.login(username.trim(), password);
      void navigate('/admin');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <main className="admin-login">
      <form className="admin-login-form" onSubmit={(e) => void submit(e)}>
        <h1>운영자 로그인</h1>
        <label className="field">
          <span>아이디</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error !== null && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary">
          로그인
        </button>
      </form>
    </main>
  );
}
