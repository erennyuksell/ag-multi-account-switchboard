/**
 * OAuth success page template.
 * Shown in the browser after a successful Google OAuth callback.
 */
export function getOAuthSuccessHtml(email: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Account Connected — Antigravity</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}

body{
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  min-height:100vh;display:flex;justify-content:center;align-items:center;
  background:#0a0a0f;color:#e2e8f0;overflow:hidden;
}

/* Animated gradient mesh background */
.bg{position:fixed;inset:0;z-index:0}
.bg .orb{position:absolute;border-radius:50%;filter:blur(100px);opacity:.35;animation:drift 12s ease-in-out infinite alternate}
.bg .orb:nth-child(1){width:500px;height:500px;background:radial-gradient(circle,#6366f1,transparent 70%);top:-10%;left:-5%;animation-delay:0s}
.bg .orb:nth-child(2){width:400px;height:400px;background:radial-gradient(circle,#8b5cf6,transparent 70%);bottom:-15%;right:-5%;animation-delay:-4s}
.bg .orb:nth-child(3){width:300px;height:300px;background:radial-gradient(circle,#06b6d4,transparent 70%);top:40%;left:60%;animation-delay:-8s}

@keyframes drift{
  0%{transform:translate(0,0) scale(1)}
  50%{transform:translate(30px,-20px) scale(1.1)}
  100%{transform:translate(-20px,30px) scale(.95)}
}

/* Card */
.card{
  position:relative;z-index:1;
  width:420px;max-width:90vw;
  padding:48px 40px 40px;
  border-radius:20px;
  background:rgba(30,30,46,.65);
  backdrop-filter:blur(24px) saturate(1.5);
  -webkit-backdrop-filter:blur(24px) saturate(1.5);
  border:1px solid rgba(255,255,255,.08);
  box-shadow:0 24px 64px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.03) inset;
  text-align:center;
  animation:cardIn .6s cubic-bezier(.16,1,.3,1) both;
}

@keyframes cardIn{
  from{opacity:0;transform:translateY(24px) scale(.96)}
  to{opacity:1;transform:translateY(0) scale(1)}
}

/* Animated checkmark */
.check-ring{
  width:72px;height:72px;margin:0 auto 24px;position:relative;
}
.check-ring svg{width:72px;height:72px}
.check-circle{
  fill:none;stroke:#22c55e;stroke-width:3;
  stroke-dasharray:166;stroke-dashoffset:166;
  animation:strokeIn .6s .3s cubic-bezier(.65,0,.45,1) forwards;
}
.check-mark{
  fill:none;stroke:#22c55e;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;
  stroke-dasharray:48;stroke-dashoffset:48;
  animation:strokeIn .4s .7s cubic-bezier(.65,0,.45,1) forwards;
}
.check-glow{
  position:absolute;inset:-8px;border-radius:50%;
  background:radial-gradient(circle,rgba(34,197,94,.15),transparent 70%);
  animation:pulseGlow 2s 1s ease-in-out infinite;
}
@keyframes strokeIn{to{stroke-dashoffset:0}}
@keyframes pulseGlow{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.08)}}

/* Title */
h1{
  font-size:22px;font-weight:700;
  background:linear-gradient(135deg,#e2e8f0 0%,#94a3b8 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  margin-bottom:6px;letter-spacing:-.3px;
}

.subtitle{
  font-size:13px;color:#64748b;margin-bottom:24px;font-weight:400;
}

/* Email badge */
.email-badge{
  display:inline-flex;align-items:center;gap:8px;
  padding:10px 20px;border-radius:10px;
  background:rgba(99,102,241,.1);
  border:1px solid rgba(99,102,241,.2);
  font-size:14px;font-weight:500;color:#a5b4fc;
  animation:badgeIn .4s .9s cubic-bezier(.16,1,.3,1) both;
}
.email-badge .dot{
  width:8px;height:8px;border-radius:50%;background:#22c55e;
  box-shadow:0 0 8px rgba(34,197,94,.5);
  animation:blink 2s 1.5s ease-in-out infinite;
}
@keyframes badgeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}

/* Divider */
.divider{
  height:1px;margin:24px 0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);
}

/* Close hint */
.close-hint{
  font-size:12px;color:#475569;
  animation:fadeIn .4s 1.2s both;
}
.close-hint .countdown{
  display:inline-block;
  color:#64748b;font-variant-numeric:tabular-nums;
  min-width:16px;
}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}

/* Branding */
.brand{
  margin-top:28px;display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:11px;color:#334155;font-weight:500;letter-spacing:.5px;
  animation:fadeIn .4s 1.4s both;
}
.brand svg{opacity:.4}
</style>
</head>
<body>
  <div class="bg">
    <div class="orb"></div>
    <div class="orb"></div>
    <div class="orb"></div>
  </div>

  <div class="card">
    <div class="check-ring">
      <div class="check-glow"></div>
      <svg viewBox="0 0 52 52">
        <circle class="check-circle" cx="26" cy="26" r="25"/>
        <path class="check-mark" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
      </svg>
    </div>

    <h1>Account Connected</h1>
    <p class="subtitle">Quota monitoring is now active</p>

    <div class="email-badge">
      <span class="dot"></span>
      ${email}
    </div>

    <div class="divider"></div>

    <p class="close-hint">
      This tab will close in <span class="countdown" id="cd">5</span>s · or close it manually
    </p>

    <div class="brand">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      ANTIGRAVITY QUOTA PANEL
    </div>
  </div>

  <script>
    let s = 5;
    const el = document.getElementById('cd');
    const hint = document.querySelector('.close-hint');

    const t = setInterval(() => {
      s--;
      if (el) el.textContent = s;
      if (s <= 0) {
        clearInterval(t);
        // Attempt 1: standard window.close()
        window.close();
        // Attempt 2: some Chromium-based browsers allow this trick
        setTimeout(() => {
          try { window.open('', '_self', ''); window.close(); } catch(e) {}
        }, 100);
        // Attempt 3: if still open after 400ms, update UI to manual-close state
        setTimeout(() => {
          if (!window.closed && hint) {
            hint.innerHTML =
              'Authentication complete \u00b7 <strong style="color:#a5b4fc;cursor:pointer" onclick="window.close()">Close this tab \u2715</strong>';
          }
        }, 400);
      }
    }, 1000);
  </script>
</body>
</html>`;
}
