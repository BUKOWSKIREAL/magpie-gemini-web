// Package the managed backend reproducibly using Go's standard archive writers.
// Usage: go run scripts/studio-archive.go <output.tar.gz|output.zip> <binary> <LICENSE>
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	if err := pack(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func pack() error {
	if len(os.Args) != 4 {
		return fmt.Errorf("usage: studio-archive <archive> <binary> <LICENSE>")
	}
	binary, err := os.ReadFile(os.Args[2])
	if err != nil {
		return err
	}
	license, err := os.ReadFile(os.Args[3])
	if err != nil {
		return err
	}
	entries := []struct {
		name string
		data []byte
		mode int64
	}{
		{"LICENSE", license, 0644},
		{"README-MAGPIE.txt", []byte("AIStudio2API, managed by magpie-gemini-web.\nOnline updates are disabled. Upgrade through the Magpie plugin.\nSource and build instructions: https://github.com/BUKOWSKIREAL/magpie-gemini-web\n"), 0644},
		{filepath.Base(os.Args[2]), binary, 0755},
	}
	file, err := os.Create(os.Args[1])
	if err != nil {
		return err
	}
	defer file.Close()
	if strings.HasSuffix(os.Args[1], ".zip") {
		writer := zip.NewWriter(file)
		for _, entry := range entries {
			header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
			header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
			header.SetMode(os.FileMode(entry.mode))
			out, err := writer.CreateHeader(header)
			if err != nil {
				return err
			}
			if _, err = out.Write(entry.data); err != nil {
				return err
			}
		}
		if err := writer.Close(); err != nil {
			return err
		}
		return file.Close()
	}
	if !strings.HasSuffix(os.Args[1], ".tar.gz") {
		return fmt.Errorf("unsupported archive extension")
	}
	compressed, err := gzip.NewWriterLevel(file, gzip.BestCompression)
	if err != nil {
		return err
	}
	writer := tar.NewWriter(compressed)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: entry.mode, Size: int64(len(entry.data)), ModTime: time.Unix(0, 0), Format: tar.FormatUSTAR}
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if _, err := writer.Write(entry.data); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	if err := compressed.Close(); err != nil {
		return err
	}
	return file.Close()
}
