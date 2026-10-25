# VM test of the NixOS module: API, worker and browser worker against a local Postgres, Temporal
# dev server and S3 gateway, through a whole digest run (stub LLM) and a Temporal restart.
# Run with `nix build .#checks.x86_64-linux.module`.
{ pkgs, module }:
let
  page = pkgs.writeText "page.html" ''
    <html><head><title>Kernel news</title></head><body><main><h1>Rendered</h1>
    <p>The new scheduler lands in the next release, with lower latency for desktop workloads.</p>
    <p id="js"></p></main>
    <script>document.getElementById('js').textContent = 'filled in by JavaScript';</script>
    </body></html>
  '';
  # Written at boot: a source's first collection only takes posts of the last 24 hours
  writeSite = pkgs.writeShellScript "write-test-site" ''
    cp ${page} "$STATE_DIRECTORY/page.html"
    cat > "$STATE_DIRECTORY/feed.xml" <<EOF
    <?xml version="1.0"?>
    <rss version="2.0"><channel><title>Test feed</title><link>http://127.0.0.1:8000/</link>
    <description>test</description>
    <item><title>New scheduler lands</title><link>http://127.0.0.1:8000/page.html</link>
    <guid>http://127.0.0.1:8000/page.html</guid><pubDate>$(date -uR)</pubDate>
    <description>The new scheduler lands in the next release.</description></item>
    </channel></rss>
    EOF
  '';
in
pkgs.testers.runNixOSTest {
  name = "temp-oral-module";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ module ];
      virtualisation.memorySize = 3072;
      virtualisation.cores = 2;

      services.postgresql = {
        enable = true;
        ensureDatabases = [ "temp_oral" ];
        ensureUsers = [
          {
            name = "temp_oral";
            ensureDBOwnership = true;
          }
        ];
      };

      # Persistent, so schedules and workflows survive the restart below
      systemd.services.temporal-dev = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          ExecStart = "${pkgs.temporal-cli}/bin/temporal server start-dev --ip 127.0.0.1 --headless --log-level warn --db-filename /var/lib/temporal-dev/temporal.db";
          StateDirectory = "temporal-dev";
          DynamicUser = true;
          Environment = "HOME=/tmp";
        };
      };

      # Serves every directory under /var/lib/s3 as a bucket
      systemd.services.s3 = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p /var/lib/s3/temp-oral";
          ExecStart = "${pkgs.versitygw}/bin/versitygw --access test --secret testsecret --port 127.0.0.1:7070 posix /var/lib/s3";
        };
      };

      systemd.services.web = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          ExecStartPre = writeSite;
          ExecStart = "${pkgs.python3}/bin/python -m http.server 8000 --bind 127.0.0.1 --directory /var/lib/web";
          StateDirectory = "web";
          DynamicUser = true;
        };
      };

      services.temp-oral = {
        enable = true;
        dependencies = [
          "postgresql.target"
          "temporal-dev.service"
          "s3.service"
        ];
        environment = {
          DATABASE_URL = "postgres://temp_oral@localhost/temp_oral?host=/run/postgresql";
          S3_BUCKET = "temp-oral";
          S3_ENDPOINT = "http://127.0.0.1:7070";
          S3_FORCE_PATH_STYLE = "true";
          AWS_ACCESS_KEY_ID = "test";
          AWS_SECRET_ACCESS_KEY = "testsecret";
          TEMPORAL_ADDRESS = "127.0.0.1:7233";
          LLM_PROVIDER = "stub";
          OTEL_SDK_DISABLED = "true";
          # The test site is on localhost
          FETCH_ALLOW_PRIVATE_NETWORKS = "true";
        };
        # All interfaces, like on a server: Fastify then reads them over netlink
        api.host = "0.0.0.0";
        api.environment.DATABASE_POOL_MAX = "4";
        browserWorker.enable = true;
      };
    };

  testScript = ''
    import json

    def api(method, path, body=None):
      data = f"-H 'content-type: application/json' -d '{json.dumps(body)}'" if body is not None else ""
      return json.loads(machine.succeed(f"curl -sf -X{method} http://127.0.0.1:8080{path} {data}"))

    units = ["temp-oral-api", "temp-oral-worker", "temp-oral-browser-worker"]

    with subtest("all units start, migrating a fresh database at the same time"):
      for unit in units:
        machine.wait_for_unit(f"{unit}.service")
      machine.wait_until_succeeds("curl -sf http://127.0.0.1:8080/health/ready", timeout=60)
      machine.wait_until_succeeds("journalctl -u temp-oral-worker.service | grep -q 'workers started'", timeout=120)
      machine.wait_until_succeeds("journalctl -u temp-oral-browser-worker.service | grep -q 'workers started'", timeout=120)
      # The migration lock serialises them: one unit applies everything, the others find every
      # schema up to date
      applied = {}
      for unit in units:
        journal = machine.succeed(f"journalctl -u {unit}.service")
        applied[unit] = journal.count('"migration applied"')
        assert '"migration failed"' not in journal, unit
        assert applied[unit] > 0 or journal.count('"schema up to date"') == 3, unit
      assert sorted(n > 0 for n in applied.values()) == [False, False, True], applied

    with subtest("per-unit environment"):
      env = machine.succeed("systemctl show -p Environment temp-oral-browser-worker.service")
      assert "DATABASE_POOL_MAX=2" in env and "WORKER_TASK_QUEUES=sources-browser" in env, env
      assert "DATABASE_POOL_MAX=4" in machine.succeed("systemctl show -p Environment temp-oral-api.service")

    with subtest("only the worker serving the digests queue manages its schedule"):
      machine.wait_until_succeeds("journalctl -u temp-oral-worker.service | grep -q 'daily-digest'", timeout=30)
      machine.fail("journalctl -u temp-oral-browser-worker.service | grep -q 'daily-digest'")

    with subtest("browser preview renders JavaScript inside the sandbox"):
      preview = api("POST", "/sources/preview", {"url": "http://127.0.0.1:8000/page.html", "kind": "page", "fetchMode": "browser"})
      assert "filled in by JavaScript" in json.dumps(preview), preview

    with subtest("units survive a Temporal restart"):
      machine.succeed("systemctl stop temporal-dev.service")
      machine.sleep(3)
      machine.succeed("systemctl start temporal-dev.service")
      for unit in units:
        machine.wait_until_succeeds(f"systemctl is-active {unit}.service", timeout=60)

    with subtest("a digest runs end to end and is published to S3"):
      api("POST", "/sources", {"name": "Test feed", "url": "http://127.0.0.1:8000/feed.xml"})
      api("POST", "/digests/runs", {})
      machine.wait_until_succeeds(
        "curl -sf http://127.0.0.1:8080/digests | grep -q '\"status\":\"published\"'", timeout=180
      )
      print(machine.succeed("curl -sf http://127.0.0.1:8080/digests"))
      machine.succeed("find /var/lib/s3/temp-oral/sources/exports -name '*.jsonl' | grep -q .")
      machine.succeed("grep -q 'New scheduler lands' /var/lib/s3/temp-oral/digests/latest/index.html")

    with subtest("no errors logged"):
      machine.fail("journalctl -u 'temp-oral-*' | grep -q '\"level\":\\(50\\|60\\)'")

    for unit in units:
      print(machine.succeed(f"systemd-analyze security {unit}.service | tail -1"))
  '';
}
