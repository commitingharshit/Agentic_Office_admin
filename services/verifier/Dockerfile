# The verifier: Hermes skill scanner + agent blueprint compiler behind HTTP (see server.py). Build with deploy/scripts/build-verifier.sh,
# which copies the pinned Hermes files into ./hermes first (they are not committed here; HERMES_REF names the monorepo commit they came from).
FROM python:3.12-slim
RUN pip install --no-cache-dir pyyaml requests httpx rich click pygments jiter attrs certifi \
 && useradd --system --uid 10001 --no-create-home verifier
WORKDIR /opt/verifier
COPY server.py HERMES_REF ./
COPY hermes/ /opt/hermes/
USER verifier
ENV HERMES_DIR=/opt/hermes VERIFIER_PORT=8089 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8089
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8089/healthz', timeout=4)"]
CMD ["python", "/opt/verifier/server.py"]
