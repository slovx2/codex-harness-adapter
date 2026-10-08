package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUserEnvironmentFileParsing(t *testing.T) {
	home := t.TempDir()
	if values, err := loadUserEnvironment(home); err != nil || len(values) != 0 {
		t.Fatalf("缺少文件应视为空配置: %v %v", values, err)
	}
	content := "# 注释\n\nCHA_CLAUDE_DEFAULT_MODEL=opus\nexport HTTPS_PROXY=\"http://127.0.0.1:7890\"\nPI_CLI='/opt/pi bin/pi'\nEMPTY=\nWITH_EQUALS=a=b\n"
	if err := os.WriteFile(userEnvironmentPath(home), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := loadUserEnvironment(home)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"CHA_CLAUDE_DEFAULT_MODEL": "opus", "HTTPS_PROXY": "http://127.0.0.1:7890",
		"PI_CLI": "/opt/pi bin/pi", "EMPTY": "", "WITH_EQUALS": "a=b",
	}
	if len(values) != len(expected) {
		t.Fatalf("解析结果数量不符: %v", values)
	}
	for name, value := range expected {
		if values[name] != value {
			t.Fatalf("%s 应为 %q，实际 %q", name, value, values[name])
		}
	}
}

func TestUserEnvironmentFileRejectsInvalidLine(t *testing.T) {
	for _, line := range []string{"NO_EQUALS", "1BAD=x", "BAD NAME=x"} {
		home := t.TempDir()
		if err := os.WriteFile(filepath.Join(home, "env"), []byte("OK=1\n"+line+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadUserEnvironment(home); err == nil || !strings.Contains(err.Error(), "第 2 行") {
			t.Fatalf("%q 应报告第 2 行格式无效: %v", line, err)
		}
	}
}

func TestEnvironmentPrecedence(t *testing.T) {
	cfg := testConfiguration(t)
	t.Setenv("CHA_TEST_FROM_PROCESS", "process")
	cfg.userEnv = map[string]string{
		"CHA_TEST_FROM_PROCESS": "file", "CHA_TEST_FROM_FILE": "file", "CODEX_HOME": "/ignored",
	}
	values := map[string]string{}
	for _, entry := range cfg.environment() {
		name, value, _ := strings.Cut(entry, "=")
		if _, duplicate := values[name]; duplicate {
			t.Fatalf("环境变量重复: %s", name)
		}
		values[name] = value
	}
	if values["CHA_TEST_FROM_PROCESS"] != "process" || values["CHA_TEST_FROM_FILE"] != "file" {
		t.Fatalf("启动进程变量应优先于环境文件: %v", values)
	}
	if values["CODEX_HOME"] != filepath.Join(cfg.directory(), "codex") {
		t.Fatalf("适配器固定变量不可被覆盖: %s", values["CODEX_HOME"])
	}
}
