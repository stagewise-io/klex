# Spike image: a GUI Linux desktop driven by klex-machine's desktop_* tools.
# Build context is mcp-servers/klex-machine after `pnpm --filter @klex/machine build`.
FROM node:24-bookworm

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-tools \
    xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfce4-settings thunar \
    dbus-x11 at-spi2-core x11-utils x11-xserver-utils xdotool xclip imagemagick \
    fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core fonts-liberation \
    supervisor ca-certificates curl gnupg \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/* \
  && dbus-uuidgen --ensure=/etc/machine-id \
  && rm -f /usr/share/backgrounds/xfce/*

RUN useradd --create-home --uid 1001 --shell /bin/bash user \
  && install -d -o user -g user -m 0700 /run/klex /home/user/workspace

COPY package.json /opt/klex-machine/package.json
RUN cd /opt/klex-machine \
  && node -e "const p=require('./package.json');require('fs').writeFileSync('package.json',JSON.stringify({name:'klex-machine-runtime',version:p.version,private:true,type:'module',dependencies:{'node-pty':p.dependencies['node-pty']}}))" \
  && npm install --omit=dev --no-audit --no-fund
COPY dist/ /opt/klex-machine/dist/
RUN chmod 0755 /opt/klex-machine/dist/index.js \
  && ln -s /opt/klex-machine/dist/index.js /usr/local/bin/klex-machine

COPY examples/desktop/supervisord.conf /etc/supervisor/desktop.conf
COPY examples/desktop/bin/ /usr/local/bin/
COPY examples/desktop/smoke.mjs /opt/klex-machine/examples/smoke.mjs

ENV DISPLAY=:1 \
  KLEX_BROWSER_NO_SANDBOX=1 \
  KLEX_MACHINE_CWD=/home/user/workspace \
  HOME=/home/user
USER user
WORKDIR /home/user/workspace
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/desktop.conf"]
