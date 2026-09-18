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
  <title>Willkommen</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Arial, sans-serif;
      background: #111;
      color: white;
    }

    .container {
      width: 100%;
      padding: 20px;
    }

    .card {
      width: min(420px, 100%);
      margin: auto;
      padding: 40px;
      text-align: center;
      background: #1c1c1c;
      border: 1px solid #333;
      border-radius: 16px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
    }

    h1 {
      margin: 0 0 10px;
      font-size: 32px;
    }

    p {
      color: #aaa;
      margin-bottom: 25px;
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
      border-radius: 10px;
      font-size: 16px;
    }

    input {
      border: 1px solid #444;
      background: #111;
      color: white;
      outline: none;
    }

    input:focus {
      border-color: #777;
    }

    button {
      border: none;
      background: white;
      color: #111;
      font-weight: bold;
      cursor: pointer;
      transition:
        background 0.2s ease,
        transform 0.15s ease,
        box-shadow 0.25s ease;
    }

    button:hover {
      background: #ddd;
      box-shadow:
        0 0 8px rgba(255, 255, 255, 0.5),
        0 0 20px rgba(255, 255, 255, 0.25);
      transform: translateY(-1px);
    }

    button:active {
      transform: scale(0.96);
      box-shadow: 0 0 5px rgba(255, 255, 255, 0.3);
    }

    .error {
      display: ${withError ? 'block' : 'none'};
      margin: 18px 0 0;
      color: #ff6b6b;
    }
  </style>
</head>
<body>
  <main class="container">
    <div class="card">
      <h1>Willkommen👋</h1>
      <p>Bitte gib das Passwort ein, um fortzufahren.</p>

      <form method="post" action="/cfp_login">
        <input type="hidden" name="redirect" value="${redirectPath}" />
        <input
          type="password"
          name="password"
          placeholder="Passwort"
          autocomplete="off"
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