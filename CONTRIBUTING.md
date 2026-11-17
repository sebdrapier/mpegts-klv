# Contributing

```sh
bun install
bun test
bun run typecheck
bun run build
```

Tests build synthetic MPEG-TS streams in `test/index.test.ts`. If you change the demuxer, also compare its output with ffmpeg on a real file of your own:

```sh
ffmpeg -i in.ts -map 0:d -c copy -f data ffmpeg.bin
```

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, see [SECURITY.md](SECURITY.md).
