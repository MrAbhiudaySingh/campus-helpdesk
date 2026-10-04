const API = (() => {
  function token() {
    return localStorage.getItem('helpdesk_token');
  }
  function setToken(t) {
    if (t) localStorage.setItem('helpdesk_token', t);
    else localStorage.removeItem('helpdesk_token');
  }

  async function req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* no body */
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    token,
    setToken,
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b || {}),
    patch: (p, b) => req('PATCH', p, b || {}),
  };
})();
