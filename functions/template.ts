export function getTemplate({
  redirectPath,
  withError
}: {
  redirectPath: string;
  withError: boolean;
}): string {
  return `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Noma Music</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      background: #0a0a0a;
      color: #f2f2f2;
      overflow: hidden;
      -webkit-user-select: none;
      user-select: none;
    }

    .bg-layer {
      position: fixed;
      inset: -80px;
      background-image: url("/Assets/Logo/NomaMusicLogoSquare.jpg");
      background-size: cover;
      background-position: center;
      filter: blur(52px) saturate(1.45) brightness(0.62);
      opacity: 0.42;
      transform: scale(1.15);
      z-index: 0;
      pointer-events: none;
      animation: bgDrift 22s ease-in-out infinite alternate;
    }

    .bg-layer::after {
      content: "";
      position: absolute;
      inset: -10%;
      background: inherit;
      background-size: cover;
      background-position: center;
      filter: blur(36px) saturate(1.55);
      opacity: 0.45;
      mix-blend-mode: screen;
      animation: bgDrift 30s ease-in-out infinite alternate-reverse;
    }

    .bg-overlay {
      position: fixed;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      background: linear-gradient(
        180deg,
        rgba(10, 10, 10, 0.4) 0%,
        rgba(10, 10, 10, 0.7) 55%,
        rgba(10, 10, 10, 0.88) 100%
      );
    }

    @keyframes bgDrift {
      0%   { transform: scale(1.12) translate(-2%, -1%) rotate(-0.8deg); }
      50%  { transform: scale(1.2)  translate(2%, 1%)   rotate(0.8deg); }
      100% { transform: scale(1.15) translate(-1%, 2%)  rotate(-0.4deg); }
    }

    .container {
      position: relative;
      z-index: 2;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 28px;
      padding: 24px;
    }

    /* Logo stands alone — not inside the password card */
    .brand-logo {
      display: block;
      width: min(340px, 78vw);
      height: auto;
      object-fit: contain;
      -webkit-user-drag: none;
      user-drag: none;
      filter: drop-shadow(0 8px 28px rgba(0, 0, 0, 0.45));
    }

    .card {
      width: min(400px, 100%);
      padding: 32px 28px 28px;
      text-align: center;
      background: rgba(20, 20, 20, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .subtitle {
      color: #9a9a9a;
      font-size: 0.95rem;
      margin-bottom: 24px;
      line-height: 1.4;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    input,
    button {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      font-size: 1rem;
      font-family: inherit;
    }

    input {
      border: 1px solid #333;
      background: rgba(10, 10, 10, 0.85);
      color: #f2f2f2;
      outline: none;
      transition: border-color 0.2s ease;
    }

    input:focus {
      border-color: #7c9cff;
    }

    button {
      border: none;
      background: #fff;
      color: #111;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.25s ease;
    }

    button:hover {
      background: #eee;
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.25);
      transform: translateY(-1px);
    }

    button:active {
      transform: scale(0.97);
    }

    .error {
      display: ${withError ? "block" : "none"};
      margin: 16px 0 0;
      color: #ff6b6b;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="bg-layer" aria-hidden="true"></div>
  <div class="bg-overlay" aria-hidden="true"></div>

  <main class="container">
    <img
      class="brand-logo"
      src="/Assets/Logo/NomaMusicLogoText.png"
      alt="Noma Music"
    >

    <div class="card">
      <h1>Willkommen 👋</h1>
      <p class="subtitle">Bitte gib das Passwort ein, um fortzufahren.</p>

      <form method="post" action="/cfp_login">
        <input type="hidden" name="redirect" value="${redirectPath}" />
        <input
          type="password"
          name="password"
          placeholder="Passwort"
          autocomplete="current-password"
          required
          autofocus
        >
        <button type="submit">Weiter</button>
      </form>

      <p class="error">Falsches Passwort.</p>
    </div>
  </main>
</body>
</html>
  `;
}