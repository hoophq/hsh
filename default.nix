{ stdenv, bun, bun2nix, system, lib }:
let
  bunTarget = {
    "x86_64-linux" = "bun-linux-x64";
    "aarch64-linux" = "bun-linux-arm64";
    "x86_64-darwin" = "bun-darwin-x64";
    "aarch64-darwin" = "bun-darwin-arm64";
  }.${system} or "bun-linux-x64";
in
stdenv.mkDerivation {
  pname = "hsh";
  version = "0.1.0";

  src = ./.;

  nativeBuildInputs = [
    bun
    bun2nix.hook
  ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };

  buildPhase = ''
    runHook preBuild
    bun build --compile --target=${bunTarget} src/index.ts --outfile hsh
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    install -m755 hsh $out/bin/hsh
    runHook postInstall
  '';

  meta = {
    description = "Hoop Shell Plugins — Seamless access to infrastructure via shell integration";
    homepage = "https://hoop.dev";
    license = lib.licenses.mit;
    mainProgram = "hsh";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
