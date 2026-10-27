// Recompress the web build's precompressed .gz assets with Go's compress/gzip, so they are the
// same bytes on every platform. Upstream's build gzips them with Node's zlib, whose output
// differs between CPUs and systems; the assets are embedded in the binary, so the binary and
// its archive differed between builders even though the assets themselves were identical.
// Usage: go run scripts/studio-regzip.go <dist directory>
package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: studio-regzip <dist directory>")
		os.Exit(1)
	}
	count := 0
	err := filepath.WalkDir(os.Args[1], func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".gz") {
			return err
		}
		if err := regzip(path); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		count++
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("Recompressed %d web assets with Go's gzip\n", count)
}

func regzip(path string) error {
	compressed, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	r, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return err
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if err := r.Close(); err != nil {
		return err
	}
	var out bytes.Buffer
	// A zero header: no name, no modification time.
	w, err := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	return os.WriteFile(path, out.Bytes(), info.Mode().Perm())
}
