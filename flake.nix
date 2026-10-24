{
  description = "TypeScript service: hexagonal DDD, Postgres, S3, Temporal, OpenTelemetry";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          # Grafana 13 ships Tempo as a separate plugin
          grafanaPlugins = pkgs.linkFarm "grafana-plugins" [
            {
              name = "tempo";
              path = pkgs.grafanaPlugins.tempo;
            }
            {
              name = "victoriametrics-logs-datasource";
              path = pkgs.grafanaPlugins.victoriametrics-logs-datasource;
            }
            # VictoriaMetrics speaks PromQL; Grafana 13 ships the Prometheus datasource separately
            {
              name = "prometheus";
              path = pkgs.grafanaPlugins.prometheus;
            }
          ];
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # app toolchain
              nodejs_26
              pnpm
              biome
              watchexec # restarts the worker in dev; node --watch breaks Temporal workflow threads

              # local infrastructure (orchestrated by process-compose.yaml)
              process-compose
              postgresql_18
              versitygw # S3-compatible gateway (MinIO was removed from nixpkgs)
              temporal-cli
              tempo
              victorialogs
              victoriametrics
              grafana
            ];

            shellHook = ''
              export PROJECT_ROOT="$PWD"
              export DEV_DATA_DIR="$PWD/.data"
              export GRAFANA_HOME="${pkgs.grafana}/share/grafana"
              export GRAFANA_PLUGINS_DIR="${grafanaPlugins}"
              export TEMPORAL_CLI_PATH="${pkgs.temporal-cli}/bin/temporal"
              # process-compose's control API defaults to :8080, which the HTTP API uses
              export PC_PORT_NUM=8099
              # Biome from nixpkgs; the npm package ships a binary that will not run on NixOS
              export BIOME_BINARY="${pkgs.biome}/bin/biome"
            ''
            # Headless Chromium for browser sources. playwright-core in package.json is pinned to
            # this playwright-driver's version, since each Playwright release expects its own build.
            + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export PLAYWRIGHT_BROWSERS_PATH="${
                pkgs.playwright-driver.browsers.override {
                  withChromium = false;
                  withFirefox = false;
                  withWebkit = false;
                  withFfmpeg = false;
                }
              }"
            '';
          };
        }
      );
    };
}
