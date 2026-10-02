package main

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"testing"
)

// Decode the browser's archive using an independent implementation, including CRC validation.
func TestBrowserFolderZIP(t *testing.T) {
	archive, err := os.ReadFile("testdata/folder.zip")
	if err != nil {
		t.Fatal(err)
	}
	r, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]byte{"folder/": {}, "folder/empty/": {}, "folder/nested/Привіт.txt": []byte("  hello\t🦊\r\n"), "folder/raw.bin": {0, 255, 13, 10}, "folder/empty.bin": {}}
	if len(r.File) != len(want) {
		t.Fatalf("got %d entries", len(r.File))
	}
	for _, f := range r.File {
		expected, ok := want[f.Name]
		if !ok {
			t.Fatalf("unexpected path %q", f.Name)
		}
		reader, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, expected) {
			t.Fatalf("bytes differ for %s", f.Name)
		}
		if f.Method != zip.Store {
			t.Fatalf("unexpected compression for %s", f.Name)
		}
		if f.Name == "folder/empty/" && !f.FileInfo().IsDir() {
			t.Fatal("lost empty directory")
		}
	}
}
