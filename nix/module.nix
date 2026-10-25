# services.temp-oral: HTTP API, Temporal worker and (optionally) a browser worker as systemd
# services. The host provides Postgres, S3 and Temporal and passes their addresses in
# `environment`; secrets (OPENAI_API_KEY, AWS_*) go in `environmentFiles`.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.temp-oral;

  environmentOption =
    description:
    lib.mkOption {
      type = with lib.types; attrsOf str;
      default = { };
      inherit description;
    };

  hardening = {
    DynamicUser = true;
    # Postgres peer auth over the socket maps this name to a role
    User = cfg.user;
    EnvironmentFile = cfg.environmentFiles;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    ProtectClock = true;
    ProtectHostname = true;
    ProtectKernelLogs = true;
    ProtectKernelModules = true;
    ProtectKernelTunables = true;
    ProtectControlGroups = true;
    # Not ProcSubset=pid: Temporal's core reads /proc/meminfo to size its worker
    ProtectProc = "invisible";
    NoNewPrivileges = true;
    CapabilityBoundingSet = "";
    LockPersonality = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    RestrictNamespaces = true;
    RestrictAddressFamilies = [
      "AF_UNIX"
      "AF_INET"
      "AF_INET6"
    ];
    SystemCallArchitectures = "native";
    SystemCallFilter = [
      "@system-service"
      "~@privileged @resources"
    ];
    # Not MemoryDenyWriteExecute: V8's JIT needs writable executable memory
    UMask = "0077";
  };

  # Every unit migrates before it starts: migrations take a lock and are a no-op when up to
  # date, and a failed one fails the start, which Restart= retries. External dependencies are
  # only wanted, so a restart or outage of Postgres or Temporal doesn't stop these units for
  # good; they reconnect or exit and are restarted.
  appService =
    {
      description,
      entry,
      environment,
      serviceConfig ? { },
    }:
    {
      inherit description;
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ] ++ cfg.dependencies;
      after = [ "network-online.target" ] ++ cfg.dependencies;
      environment = cfg.environment // environment;
      # Retry forever; RestartSec keeps it from hammering a dependency that is down
      startLimitIntervalSec = 0;
      serviceConfig =
        hardening
        // {
          ExecStartPre = lib.getExe' cfg.package "temp-oral-migrate";
          ExecStart = lib.getExe' cfg.package "temp-oral-${entry}";
          Restart = "on-failure";
          RestartSec = "5s";
        }
        // serviceConfig;
    };
in
{
  options.services.temp-oral = {
    enable = lib.mkEnableOption "the temp-oral digest service";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.temp-oral;
      defaultText = lib.literalExpression "temp-oral.packages.\${system}.temp-oral";
      description = "The temp-oral package.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "temp_oral";
      description = ''
        Name of the dynamic user all units run as. With Postgres over its socket and peer
        auth, create a role of the same name.
      '';
    };

    environment = lib.mkOption {
      type = with lib.types; attrsOf str;
      default = { };
      example = {
        DATABASE_URL = "postgres://temp_oral@localhost/temp_oral?host=/run/postgresql";
        S3_BUCKET = "temp-oral";
        S3_ENDPOINT = "http://127.0.0.1:3900";
        TEMPORAL_ADDRESS = "127.0.0.1:7233";
      };
      description = ''
        Configuration for every unit, see src/shared/infrastructure/config.ts; each unit's own
        `environment` is merged over it. Don't put secrets here: the values end up in the
        world-readable Nix store.
      '';
    };

    environmentFiles = lib.mkOption {
      type = with lib.types; listOf path;
      default = [ ];
      description = "Files with secret variables (OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY, ...).";
    };

    dependencies = lib.mkOption {
      type = with lib.types; listOf str;
      default = [ ];
      example = [
        "postgresql.target"
        "temporal.service"
        "garage.service"
      ];
      description = ''
        Units every temp-oral unit wants and starts after. Wanted, not required: when one
        stops or restarts, the app reconnects or is restarted instead of staying stopped.
      '';
    };

    api = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to run the HTTP API.";
      };
      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Address the HTTP API listens on.";
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 8080;
        description = "Port the HTTP API listens on.";
      };
      environment = environmentOption "Configuration for the API only, e.g. DATABASE_POOL_MAX.";
    };

    worker = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to run the Temporal worker (every queue but sources-browser).";
      };
      environment = environmentOption "Configuration for the worker only.";
    };

    browserWorker = {
      enable = lib.mkEnableOption ''
        a separate worker for the sources-browser queue, which renders JavaScript-heavy
        sources in headless Chromium. Without it, browser sources fail and are reported
        as failed
      '';
      memoryMax = lib.mkOption {
        type = lib.types.str;
        default = "2G";
        description = "Memory limit of the browser worker (systemd MemoryMax).";
      };
      environment = environmentOption ''
        Configuration for the browser worker only, e.g. BROWSER_CONCURRENCY. It barely uses
        Postgres, so the default sets a small DATABASE_POOL_MAX.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services = {
      temp-oral-api = lib.mkIf cfg.api.enable (appService {
        description = "temp-oral HTTP API";
        entry = "api";
        environment = {
          HTTP_HOST = cfg.api.host;
          HTTP_PORT = toString cfg.api.port;
        }
        // cfg.api.environment;
        # Listening on 0.0.0.0, Fastify lists the interfaces to log their addresses, which
        # Node reads over netlink (EAFNOSUPPORT, error 97, without it)
        serviceConfig.RestrictAddressFamilies = hardening.RestrictAddressFamilies ++ [ "AF_NETLINK" ];
      });

      temp-oral-worker = lib.mkIf cfg.worker.enable (appService {
        description = "temp-oral Temporal worker";
        entry = "worker";
        environment = cfg.worker.environment // {
          BROWSER_FETCH_ENABLED = "false";
        };
        # Lets running activities finish before the worker exits
        serviceConfig.TimeoutStopSec = "90s";
      });

      temp-oral-browser-worker = lib.mkIf cfg.browserWorker.enable (appService {
        description = "temp-oral browser worker (headless Chromium)";
        entry = "worker";
        environment = {
          DATABASE_POOL_MAX = "2";
        }
        // cfg.browserWorker.environment
        // {
          BROWSER_FETCH_ENABLED = "true";
          WORKER_TASK_QUEUES = "sources-browser";
          # Chromium writes its profile and caches under HOME
          HOME = "/var/cache/temp-oral-browser";
        };
        serviceConfig = {
          CacheDirectory = "temp-oral-browser";
          MemoryMax = cfg.browserWorker.memoryMax;
          TimeoutStopSec = "90s";
          # Chromium watches network changes over netlink
          RestrictAddressFamilies = hardening.RestrictAddressFamilies ++ [ "AF_NETLINK" ];
          # and protects its memory with protection keys (pkey_alloc, killed with SIGSYS under
          # @system-service alone). Its renderers crash under the shared ~@privileged @resources
          # deny list, so the browser worker gets @system-service as is.
          SystemCallFilter = [
            "@system-service"
            "@pkey"
          ];
        };
      });
    };
  };
}
