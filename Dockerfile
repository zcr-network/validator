# ZCore Network — validator node (ZCore L1 on Avalanche Fuji).
# Validated stack: avalanchego v1.14.2 (rpcchainvm 45) + subnet-evm plugin v1.14.2.
# subnet-evm was grafted into avalanchego, so the plugin ships in the SAME avalanchego release.
# The user runs the node by setting ONLY PUBLIC_IP (their server's public IP).
# The node generates its own identity (NodeID + BLS) in the volume — no keys ship in the image.
# It bootstraps from Fuji's official network (no custom genesis) with partial sync.
FROM ubuntu:22.04
ARG TARGETARCH   # amd64 | arm64 — o buildx seta por plataforma
ARG AVER=v1.14.2

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# avalanchego v1.14.2 (arch conforme a plataforma do build)
RUN curl -fsSL -o /tmp/a.tgz https://github.com/ava-labs/avalanchego/releases/download/${AVER}/avalanchego-linux-${TARGETARCH}-${AVER}.tar.gz \
  && mkdir -p /tmp/a && tar -xzf /tmp/a.tgz -C /tmp/a \
  && install -m0755 "$(find /tmp/a -type f -name avalanchego | head -1)" /usr/local/bin/avalanchego \
  && rm -rf /tmp/a.tgz /tmp/a

# subnet-evm plugin v1.14.2 do MESMO release do avalanchego (rpcchainvm 45), instalado como o VMID
# da L1 ZCore (o nome do arquivo TEM que ser o VMID). Dois nomes: o VMID canonico do subnet-evm
# (srEXiWaH..., usado pela chain atual, criada via platform-cli) e o VMID legado por nome (gkfAB6...,
# chains antigas do avalanche-cli).
RUN curl -fsSL -o /tmp/s.tgz https://github.com/ava-labs/avalanchego/releases/download/${AVER}/subnet-evm-linux-${TARGETARCH}-${AVER}.tar.gz \
  && mkdir -p /tmp/s /root/.avalanchego/plugins && tar -xzf /tmp/s.tgz -C /tmp/s \
  && install -m0755 "$(find /tmp/s -type f -name subnet-evm | head -1)" \
       /root/.avalanchego/plugins/srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy \
  && cp /root/.avalanchego/plugins/srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy \
       /root/.avalanchego/plugins/gkfAB6apjRonXBGLnTVzeB9LG5UPJ5J4yDNfXL87jG57fkMa5 \
  && rm -rf /tmp/s.tgz /tmp/s

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9650 9651
ENTRYPOINT ["/entrypoint.sh"]
