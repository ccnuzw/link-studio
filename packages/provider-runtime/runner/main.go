package main

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"slices"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
)

const maxJSON = 1 << 20
const maxSource = 512 << 10

var hookNames = []string{"buildPrepareRequests", "parsePrepareResponses", "buildSubmitRequest", "parseSubmitResponse", "buildQueryRequest", "parseQueryResponse", "buildCancelRequest", "classifyError", "buildCheckRequest", "buildImportRequest", "parseImportResponse"}

const bootstrap = `
var module = {exports: {}};
var exports = module.exports;
var utils = {};
`

const lockdown = `
(function() {
  var constructors = [Object, Array, String, Number, Boolean, Function, Error, Date, RegExp, Symbol, Map, Set, Promise];
  for (var index = 0; index < constructors.length; index++) {
    var ctor = constructors[index];
    if (ctor && ctor.prototype) {
      Object.defineProperty(ctor.prototype, 'constructor', {value: undefined, configurable: false});
      Object.freeze(ctor.prototype);
    }
  }
  var generator = Object.getPrototypeOf(function*(){});
  Object.defineProperty(generator, 'constructor', {value: undefined, configurable: false});
  Object.freeze(generator);
  for (var index = 0; index < constructors.length; index++) if (constructors[index]) Object.freeze(constructors[index]);
  Object.freeze(JSON); Object.freeze(Math); Object.freeze(Reflect); Object.freeze(utils);
  for (var name of ['eval','Function','Promise']) Object.defineProperty(globalThis, name, {value: undefined, writable: false, configurable: false});
})();
`

type request struct {
	Source string            `json:"source"`
	Hook   string            `json:"hook"`
	Args   []json.RawMessage `json:"args"`
	Trace  bool              `json:"trace,omitempty"`
}

type response struct {
	OK     bool            `json:"ok"`
	Code   string          `json:"code,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Logs   []string        `json:"logs,omitempty"`
}

func main() {
	debug.SetMemoryLimit(64 << 20)
	var input request
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 2*maxJSON+maxSource+1))
	if err != nil || len(raw) > 2*maxJSON+maxSource || json.Unmarshal(raw, &input) != nil || len(input.Source) > maxSource {
		writeResponse(response{Code: "PLUGIN_INPUT_INVALID"})
		return
	}
	var logs []string
	result, code := execute(input, &logs)
	writeResponse(response{OK: code == "", Result: result, Code: code, Logs: logs})
}

func writeResponse(result response) {
	_ = json.NewEncoder(os.Stdout).Encode(result)
}

func execute(input request, logs *[]string) (result json.RawMessage, code string) {
	code = "PLUGIN_EXECUTION_FAILED"
	defer func() {
		if recovered := recover(); recovered != nil {
			result, code = nil, "PLUGIN_EXECUTION_FAILED"
			if _, interrupted := recovered.(*goja.InterruptedError); interrupted {
				code = "PLUGIN_TIMEOUT"
				if recovered.(*goja.InterruptedError).Value() == "memory" {
					code = "PLUGIN_MEMORY_LIMIT"
				}
			}
		}
	}()
	vm := goja.New()
	vm.SetMaxCallStackSize(256)
	var interrupted atomic.Bool
	interrupt := func(cause string) {
		if interrupted.CompareAndSwap(false, true) {
			vm.Interrupt(cause)
		}
	}
	timer := time.AfterFunc(200*time.Millisecond, func() { interrupt("timeout") })
	defer timer.Stop()
	done := make(chan struct{})
	defer close(done)
	go monitorMemory(interrupt, done)
	result, err := run(vm, input, logs)
	if err != nil {
		var interrupted *goja.InterruptedError
		if errors.As(err, &interrupted) {
			if interrupted.Value() == "memory" {
				return nil, "PLUGIN_MEMORY_LIMIT"
			}
			return nil, "PLUGIN_TIMEOUT"
		}
		return nil, code
	}
	if len(result) > maxJSON {
		return nil, "PLUGIN_OUTPUT_LIMIT"
	}
	return result, ""
}

func monitorMemory(interrupt func(string), done <-chan struct{}) {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			var memory runtime.MemStats
			runtime.ReadMemStats(&memory)
			if memory.Alloc > 48<<20 {
				interrupt("memory")
				return
			}
		}
	}
}

func run(vm *goja.Runtime, input request, logs *[]string) (json.RawMessage, error) {
	if _, err := vm.RunString(bootstrap); err != nil {
		return nil, err
	}
	if err := installUtils(vm, input.Trace, logs); err != nil {
		return nil, err
	}
	if _, err := vm.RunString(lockdown); err != nil {
		return nil, err
	}
	if _, err := vm.RunScript("plugin.js", input.Source); err != nil {
		return nil, err
	}
	exported := vm.Get("module").ToObject(vm).Get("exports").ToObject(vm)
	if input.Hook == "inspect" {
		return inspect(vm, exported)
	}
	known := false
	for _, name := range hookNames {
		known = known || input.Hook == name
	}
	hook, callable := goja.AssertFunction(exported.Get(input.Hook))
	if !known || !callable {
		return nil, errors.New("missing hook")
	}
	parse, _ := goja.AssertFunction(vm.Get("JSON").ToObject(vm).Get("parse"))
	args := make([]goja.Value, 0, len(input.Args))
	for _, raw := range input.Args {
		if len(raw) > maxJSON {
			return nil, errors.New("input limit")
		}
		value, err := parse(goja.Undefined(), vm.ToValue(string(raw)))
		if err != nil {
			return nil, err
		}
		args = append(args, value)
	}
	value, err := hook(exported, args...)
	if err != nil {
		return nil, err
	}
	return encode(vm, value)
}

func inspect(vm *goja.Runtime, exported *goja.Object) (json.RawMessage, error) {
	hooks := []string{}
	warnings := []string{}
	for _, name := range hookNames {
		if _, ok := goja.AssertFunction(exported.Get(name)); ok {
			hooks = append(hooks, name)
		}
	}
	for _, name := range exported.Keys() {
		if _, ok := goja.AssertFunction(exported.Get(name)); ok && !slices.Contains(hookNames, name) {
			warnings = append(warnings, name)
		}
	}
	meta, err := encode(vm, exported.Get("meta"))
	if err != nil || len(meta) > 64<<10 {
		return nil, errors.New("invalid meta")
	}
	return json.Marshal(map[string]any{"meta": meta, "hooks": hooks, "unknownHooks": warnings})
}

func encode(vm *goja.Runtime, value goja.Value) (json.RawMessage, error) {
	stringify, _ := goja.AssertFunction(vm.Get("JSON").ToObject(vm).Get("stringify"))
	encoded, err := stringify(goja.Undefined(), value)
	if err != nil {
		return nil, err
	}
	if goja.IsUndefined(encoded) {
		return nil, errors.New("not JSON")
	}
	return json.RawMessage(encoded.String()), nil
}

func installUtils(vm *goja.Runtime, trace bool, logs *[]string) error {
	utils := vm.Get("utils").ToObject(vm)
	text := func(call goja.FunctionCall, index int) string {
		value := call.Argument(index).String()
		if len(value) > 256<<10 {
			panic(vm.ToValue("utility input limit"))
		}
		return value
	}
	functions := map[string]func(goja.FunctionCall) goja.Value{
		"base64": func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(base64.StdEncoding.EncodeToString([]byte(text(call, 0))))
		},
		"base64URL": func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(base64.RawURLEncoding.EncodeToString([]byte(text(call, 0))))
		},
		"base64Decode": func(call goja.FunctionCall) goja.Value {
			decoded, err := base64.StdEncoding.DecodeString(text(call, 0))
			if err != nil {
				panic(vm.ToValue("invalid base64"))
			}
			return vm.ToValue(string(decoded))
		},
		"sha256": func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(fmt.Sprintf("%x", sha256.Sum256([]byte(text(call, 0)))))
		},
		"hmacSHA256": func(call goja.FunctionCall) goja.Value {
			mac := hmac.New(sha256.New, []byte(text(call, 0)))
			_, _ = mac.Write([]byte(text(call, 1)))
			return vm.ToValue(hex.EncodeToString(mac.Sum(nil)))
		},
		"hmacSHA256Hex": func(call goja.FunctionCall) goja.Value {
			key, err := hex.DecodeString(text(call, 0))
			if err != nil {
				panic(vm.ToValue("invalid hex"))
			}
			mac := hmac.New(sha256.New, key)
			_, _ = mac.Write([]byte(text(call, 1)))
			return vm.ToValue(hex.EncodeToString(mac.Sum(nil)))
		},
		"jwtSignRS256": func(call goja.FunctionCall) goja.Value {
			claims := call.Argument(0).Export()
			key := parseRSAPrivateKey(vm, text(call, 1))
			payload, err := json.Marshal(claims)
			if err != nil {
				panic(vm.ToValue("JWT claims cannot be encoded as JSON"))
			}
			header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
			encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
			input := header + "." + encodedPayload
			digest := sha256.Sum256([]byte(input))
			signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			if err != nil {
				panic(vm.ToValue("RS256 signing failed"))
			}
			return vm.ToValue(input + "." + base64.RawURLEncoding.EncodeToString(signature))
		},
		"jwtSignHS256": func(call goja.FunctionCall) goja.Value {
			claims := call.Argument(0).Export()
			payload, err := json.Marshal(claims)
			if err != nil {
				panic(vm.ToValue("JWT claims cannot be encoded as JSON"))
			}
			header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
			encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
			input := header + "." + encodedPayload
			mac := hmac.New(sha256.New, []byte(text(call, 1)))
			_, _ = mac.Write([]byte(input))
			return vm.ToValue(input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
		},
		"uuid": func(goja.FunctionCall) goja.Value {
			var value [16]byte
			if _, err := rand.Read(value[:]); err != nil {
				panic(vm.ToValue("random unavailable"))
			}
			value[6] = (value[6] & 15) | 64
			value[8] = (value[8] & 63) | 128
			return vm.ToValue(fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]))
		},
		"unixNow": func(goja.FunctionCall) goja.Value { return vm.ToValue(time.Now().Unix()) },
		"log": func(call goja.FunctionCall) goja.Value {
			if trace && len(*logs) < 50 {
				message := text(call, 0)
				*logs = append(*logs, message[:min(len(message), 1024)])
			}
			return goja.Undefined()
		},
	}
	for name, function := range functions {
		if err := utils.Set(name, function); err != nil {
			return err
		}
	}
	return nil
}

func parseRSAPrivateKey(vm *goja.Runtime, value string) *rsa.PrivateKey {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		panic(vm.ToValue("RS256 private key is not valid PEM"))
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if key, ok := parsed.(*rsa.PrivateKey); ok {
			return key
		}
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key
	}
	panic(vm.ToValue("RS256 private key is not RSA"))
}
