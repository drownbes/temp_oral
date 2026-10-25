# The deployable app: production node_modules plus src/, run by Node directly (type stripping,
# no build step). Binaries: temp-oral-api, temp-oral-worker, temp-oral-migrate.
{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_12,
  nodejs_26,
  makeWrapper,
  playwrightBrowsers,
}:
let
  packageJson = lib.importJSON ../package.json;
  # Pinned to a major: the store format changes between them, and with it the deps hash
  pnpm = pnpm_12;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "temp-oral";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      (lib.fileset.difference ../src (
        lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ../src
      ))
    ];
  };

  nativeBuildInputs = [
    nodejs_26
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmInstallFlags = [ "--prod" ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmInstallFlags
      ;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-hAV8UTPh3kZzOkDTK1xbDDJ7OIuhqY8357uaJo8ujPI=";
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    app=$out/lib/temp-oral
    mkdir -p $app $out/bin
    cp -r package.json src node_modules $app/

    # Temporal's native bridge ships prebuilt binaries for every platform plus its Rust
    # sources (~150M); only this platform's binary is loaded
    for bridge in $app/node_modules/.pnpm/@temporalio+core-bridge@*/node_modules/@temporalio/core-bridge; do
      rm -r $bridge/sdk-core
      find $bridge/releases -mindepth 1 -maxdepth 1 ! -name ${stdenv.hostPlatform.config} -exec rm -r {} +
      test -e $bridge/releases/${stdenv.hostPlatform.config}/index.node
    done

    # Telemetry reports npm_package_version as service.version (set by `pnpm run` in dev)
    for entry in api worker migrate; do
      makeWrapper ${lib.getExe nodejs_26} $out/bin/temp-oral-$entry \
        --add-flags $app/src/main/$entry.ts \
        --chdir $app \
        --set-default NODE_ENV production \
        --set-default npm_package_version ${finalAttrs.version}
    done
    # Chromium for the sources-browser queue, the build playwright-core expects
    wrapProgram $out/bin/temp-oral-worker \
      --set-default PLAYWRIGHT_BROWSERS_PATH ${playwrightBrowsers}

    runHook postInstall
  '';

  meta = {
    description = "Daily digest of tracked websites: API, Temporal worker and migrations";
    mainProgram = "temp-oral-api";
    platforms = lib.platforms.linux;
  };
})
