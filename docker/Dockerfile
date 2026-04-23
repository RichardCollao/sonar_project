# ─────────────────────────────────────────────────────────────────
# Dockerfile raíz — contexto: /home/richard/www (raíz del proyecto)
#
# Imagen única: Node.js 18 + Java 17 + sonar-scanner CLI + git
# La app (node-pty) ejecuta sonar-scanner como proceso local,
# por lo que ambos deben coexistir en el mismo contenedor.
#
# COPY usa rutas relativas al build context (/home/richard/www)
# ─────────────────────────────────────────────────────────────────
FROM node:18-bookworm-slim

# WORKDIR define el directorio base para RUN, destinos relativos de COPY/ADD y CMD/ENTRYPOINT.
WORKDIR /www/dev_utils

# ── Dependencias de sistema + sonar-scanner CLI ─────────────────
# python3/make/g++ → compilación de módulos nativos (node-pty)
# wget/unzip/curl  → descarga de sonar-scanner
# git              → operaciones git del gitController
# openjdk-17-jre   → runtime Java requerido por sonar-scanner
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    wget \
    unzip \
    curl \
    git \
    openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/* \
  && wget -q https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-5.0.1.3006-linux.zip \
  && unzip -q sonar-scanner-cli-5.0.1.3006-linux.zip -d /opt \
  && mv /opt/sonar-scanner-* /opt/sonar-scanner \
  && ln -s /opt/sonar-scanner/bin/sonar-scanner /usr/local/bin/sonar-scanner \
  && rm sonar-scanner-cli-5.0.1.3006-linux.zip

ENV SONAR_SCANNER_OPTS="-server"
ENV JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"

# ── Dependencias Node.js ─────────────────────────────────────────
# COPY: ruta relativa al context (/home/richard/www) → ruta relativa al WORKDIR (/www/dev_utils)

# Se copia scripts/ antes de npm ci porque el postinstall
# ejecuta scripts/copy-vendor.js (copia assets de node_modules).
COPY dev_utils/package*.json ./ 
COPY dev_utils/scripts/ ./scripts/
# Instala dependencias exactas desde package-lock.json
# omite las de desarrollo y limpia la caché para reducir la imagen.
RUN npm ci --omit=dev && npm cache clean --force

# ── Código de la app ─────────────────────────────────────────────
COPY dev_utils/ .

# Carpetas de escritura en runtime
RUN mkdir -p /www/dev_utils/logs \
  && chown -R node:node /www

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
USER node

# Bind mounts bajo /workspace suelen ser root:root; Git 2.35+ bloquea eso (dubious ownership).
RUN git config --global --add safe.directory '*'

CMD ["npm", "start"]