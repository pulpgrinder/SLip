// basic stream

function Stream(text) {
        this.pos = 0;
        this.line = 0;
        this.col = 0;
        this.text = text;
        this.len = text.length;
};

Stream.prototype = {
        peek: function() {
                if (this.pos < this.len)
                        return this.text.charAt(this.pos);
        },
        next: function() {
                if (this.pos < this.len) {
                        var ch = this.text.charAt(this.pos++);
                        if (ch == "\n") {
                                ++this.line;
                                this.col = 0;
                        } else {
                                ++this.col;
                        }
                        return ch;
                }
        }
};

////////////////// basic parser
function lisp_parse(code) {
        var list = LispCons.fromArray;
        var input = new Stream("(" + code + ")");
        function next() { return input.next(); };
        function peek() { return input.peek(); };
        function croak(msg) {
                throw new Error(msg
                                + " / line: " + input.line
                                + ", col: " + input.col
                                + ", pos: " + input.pos);
        };
        function read_while(pred) {
                var buf = "", ch;
                while ((ch = peek()) && pred(ch)) {
                        buf += next();
                }
                return buf;
        };
        function skip_ws() {
                read_while(function(ch){
                        switch (ch) {
                            case " ":
                            case "\n":
                            case "\t":
                            case "\x0C":
                            case "\u2028":
                            case "\u2029":
                                return true;
                        }
                });
        };
        function skip(expected) {
                if (next() != expected)
                        croak("Expecting " + expected);
        };
        function read_string() {
                skip("\"");
                var escaped = false;
                var str = read_while(function(ch){
                        if (escaped) {
                                return !(escaped = false);
                        } else if (ch == "\\") {
                                return escaped = true;
                        } else {
                                return ch != "\"";
                        }
                });
                skip("\"");
                return str;
        };
        function skip_comment() {
                read_while(function(ch){ return ch != "\n"; });
        };
        function read_symbol() {
                var str = read_while(function(ch){
                        if ((ch >= "a" && ch <= "z") ||
                            (ch >= "A" && ch <= "Z") ||
                            (ch >= "0" && ch <= "9"))
                                return true;
                        switch (ch) {
                            case "%": case "$": case "_": case "-":
                            case ":": case ".": case "+": case "*":
                            case "@": case "!": case "?": case "&":
                            case "=": case "<": case ">":
                            case "[": case "]":
                            case "{": case "}":
                            case "/":
                                return true;
                        }
                });
                if (str.length > 0 && /^[0-9]*\.?[0-9]*$/.test(str))
                        return new LispNumber(parseFloat(str));
                return LispSymbol.get(str);
        };
        function read_char() {
                var ch = next() + read_while(function(ch){
                        return (ch >= "a" && ch <= "z") ||
                                (ch >= "A" && ch <= "z") ||
                                (ch >= "0" && ch <= "9") ||
                                ch == "_" || ch == "_";
                });
                if (ch.length > 1)
                        croak("Character names not supported: " + ch);
                return new LispChar(ch);
        };
        function read_sharp() {
                skip("#");
                switch (peek()) {
                    case "\\": next(); return read_char();
                    case "(": return LispCons.toArray(read_list());
                    default:
                        croak("Unsupported sharp syntax: #" + peek());
                }
        };
        function read_quote() {
                skip("'");
                return list([ LispSymbol.get("quote"), read_token() ]);
        };
        var in_qq = 0;
        function read_quasiquote() {
                skip("`");
                skip_ws();
                if (peek() != "(")
                        return list([ LispSymbol.get("quote"), read_token() ]);
                ++in_qq;
                var ret = list([ LispSymbol.get("quasiquote"), read_token() ]);
                --in_qq;
                return ret;
        };
        function read_comma() {
                if (in_qq == 0) croak("Comma outside quasiquote");
                skip(",");
                skip_ws();
                var ret;
                --in_qq;
                if (peek() == "@") {
                        next();
                        ret = list([ LispSymbol.get("qq-splice"), read_token() ]);
                }
                else ret = list([ LispSymbol.get("qq-unquote"), read_token() ]);
                ++in_qq;
                return ret;
        };
        var COMMENT = {};
        function read_token() {
                skip_ws();
                var ch = peek();
                switch (ch) {
                    case "\"": return new LispString(read_string());
                    case "(": return read_list();
                    case ";": skip_comment(); return COMMENT;
                    case "#": return read_sharp();
                    case "`": return read_quasiquote();
                    case ",": return read_comma();
                    case "'": return read_quote();
                }
                return read_symbol();
        };
        function read_list() {
                var ret = null, p;
                skip("(");
                skip_ws();
                out: while (true) switch (peek()) {
                    case ")": break out;
                    case null: break out;
                    case ".":
                        next();
                        p.cdr = read_token();
                        skip_ws();
                        break out;
                    default:
                        var tok = read_token();
                        if (tok !== COMMENT) {
                                var cell = new LispCons(tok, null);
                                if (ret) p.cdr = cell;
                                else ret = cell;
                                p = cell;
                                skip_ws();
                        }
                }
                skip(")");
                return ret;
        };
        return read_token();
};

///////////////// compiler
(function(LC){

        var cons = LC.cons
        , car = LC.car
        , cdr = LC.cdr
        , cadr = LC.cadr
        , caddr = LC.caddr
        , cadddr = LC.cadddr
        , cddr = LC.cddr
        , cdddr = LC.cdddr
        , length = LC.len
        , list = LC.fromArray;

        function find_var(name, env) {
                //console.log("Looking for %o in %o", name, env);
                for (var i = 0; i < env.length; ++i) {
                        var frame = env[i];
                        for (var j = 0; j < frame.length; ++j) {
                                if (frame[j] == name)
                                        return [ i, j ];
                        }
                }
        };

        var LABEL_NUM = 0;

        var S_LAMBDA  = LispSymbol.get("LAMBDA");
        var S_IF      = LispSymbol.get("IF");
        var S_PROGN   = LispSymbol.get("PROGN");
        var S_QUOTE   = LispSymbol.get("QUOTE");
        var S_SET     = LispSymbol.get("SET!");
        var S_T       = LispSymbol.get("T");
        var S_NIL     = LispSymbol.get("NIL");
        var S_NOT     = LispSymbol.get("NOT");
        var S_CC      = LispSymbol.get("C/C");
        var S_DEFMAC  = LispSymbol.get("DEFMACRO");

        function append() {
                var ret = [];
                for (var i = 0; i < arguments.length; ++i) {
                        var el = arguments[i];
                        if (el.length > 0)
                                ret.push.apply(ret, el);
                }
                return ret;
        };

        function gen_label() {
                return new LispLabel("L" + (++LABEL_NUM));
        };

        var seq = append;

        function gen() {
                return [ slice(arguments) ];
        };

        function constantp(x) {
                switch (x) {
                    case S_T:
                    case S_NIL:
                    case true:
                    case null:
                        return true;
                }
                return LispNumber.is(x) || LispString.is(x);
        };

        function nullp(x) {
                return x === S_NIL || x == null || (x instanceof Array && x.length == 0);
        };

        function arg_count(form, min, max) {
                if (max == null) max = min;
                var len = length(cdr(form));
                if (len < min) throw new Error("Expecting at least " + min + " arguments");
                if (len > max) throw new Error("Expecting at most " + max + " arguments");
        };

        function assert(cond, error) {
                if (!cond) throw new Error(error);
        };

        function comp(x, env, VAL, MORE) {
                if (nullp(x)) return comp_const(null, VAL, MORE);
                if (LispSymbol.is(x)) {
                        switch (x) {
                            case S_NIL: return comp_const(null, VAL, MORE);
                            case S_T: return comp_const(true, VAL, MORE);
                        }
                        return comp_var(x, env, VAL, MORE);
                }
                else if (constantp(x)) {
                        return comp_const(x, VAL, MORE);
                }
                else switch (car(x)) {
                    case S_QUOTE:
                        arg_count(x, 1);
                        return comp_const(cadr(x), VAL, MORE);
                    case S_PROGN:
                        return comp_seq(cdr(x), env, VAL, MORE);
                    case S_SET:
                        arg_count(x, 2);
                        assert(LispSymbol.is(cadr(x)), "Only symbols can be set");
                        return seq(comp(caddr(x), env, true, true),
                                   gen_set(cadr(x), env),
                                   VAL ? [] : gen("POP"),
                                   MORE ? [] : gen("RET"));
                    case S_IF:
                        arg_count(x, 2, 3);
                        return comp_if(cadr(x), caddr(x), cadddr(x), env, VAL, MORE);
                    case S_CC:
                        arg_count(x, 0);
                        return VAL ? seq(gen("CC")) : [];
                    case S_DEFMAC:
                        assert(LispSymbol.is(cadr(x)), "DEFMACRO requires a symbol name for the macro");
                        return comp_defmac(cadr(x), caddr(x), cdddr(x), env, VAL, MORE);
                    case S_LAMBDA:
                        return VAL ? seq(
                                comp_lambda(cadr(x), cddr(x), env),
                                MORE ? [] : gen("RET")
                        ) : [];
                    default:
                        if (LispSymbol.is(car(x)) && car(x).macro())
                                return comp_macroexpand(car(x), cdr(x), env, VAL, MORE);
                        return comp_funcall(car(x), cdr(x), env, VAL, MORE);
                }
        };

        function comp_macroexpand(name, args, env, VAL, MORE) {
                var m = new LispMachine();
                var code = LispMachine.assemble(
                        comp_list(LC.map(args, function(el){
                                return list([ S_QUOTE, el ]);
                        }), [])
                ).concat(name.macro(), LispMachine.assemble(gen("CALL", length(args))));
                var ast = m.run(code);
                //console.log(LispMachine.dump(ast));
                var ret = comp(ast, env, VAL, MORE);
                return ret;
        };

        function comp_defmac(name, args, body, env, VAL, MORE) {
                var func = comp_lambda(args, body, env);
                func = LispMachine.assemble(func);
                name.set("macro", func);
                return seq(
                        VAL ? gen("CONST", name) : "POP",
                        MORE ? [] : gen("RET")
                );
        };

        /////

        function gen_set(x, env) {
                var p = find_var(x, env);
                if (p) {
                        return gen("LSET", p[0], p[1]);
                }
                return gen("GSET", x);
        };

        function gen_var(name, env) {
                var pos = find_var(name, env);
                if (pos) {
                        return gen("LVAR", pos[0], pos[1]);
                }
                return gen("GVAR", name);
        };

        function comp_const(x, VAL, MORE) {
                return VAL ? seq(
                        gen("CONST", x),
                        MORE ? [] : gen("RET")
                ) : [];
        };

        function comp_var(x, env, VAL, MORE) {
                return VAL ? seq(
                        gen_var(x, env),
                        MORE ? [] : gen("RET")
                ) : [];
        };

        function comp_seq(exps, env, VAL, MORE) {
                if (nullp(exps)) return comp_const(null, VAL, MORE);
                if (nullp(cdr(exps))) return comp(car(exps), env, VAL, MORE);
                return seq(comp(car(exps), env, false, true),
                           comp_seq(cdr(exps), env, VAL, MORE));
        };

        function comp_list(exps, env) {
                if (!nullp(exps)) return seq(
                        comp(car(exps), env, true, true),
                        comp_list(cdr(exps), env)
                );
                return [];
        };

        function comp_if(pred, tthen, telse, env, VAL, MORE) {
                if (nullp(pred)) {
                        return comp(telse, env, VAL, MORE);
                }
                if (constantp(pred)) {
                        return comp(tthen, env, VAL, MORE);
                }
                if (LC.is(pred) && car(pred) === S_NOT && LC.len(pred) == 2) {
                        return comp_if(cadr(pred), telse, tthen, env, VAL, MORE);
                }
                var pcode = comp(pred, env, true, true);
                var tcode = comp(tthen, env, VAL, MORE);
                var ecode = comp(telse, env, VAL, MORE);
                var l1, l2;

                if (nullp(tcode)) {
                        l2 = gen_label();
                        return seq(
                                pcode,
                                gen("TJUMP", l2),
                                ecode,
                                [ l2 ],
                                MORE ? [] : gen("RET")
                        );
                }
                if (nullp(ecode)) {
                        l1 = gen_label();
                        return seq(
                                pcode,
                                gen("FJUMP", l1),
                                tcode,
                                [ l1 ],
                                MORE ? [] : gen("RET")
                        );
                }
                l1 = gen_label();
                if (MORE) l2 = gen_label();
                return seq(
                        pcode,
                        gen("FJUMP", l1),
                        tcode,
                        MORE ? gen("JUMP", l2) : [],
                        [ l1 ],
                        ecode,
                        MORE ? [ l2 ] : []
                );
        };

        function comp_funcall(f, args, env, VAL, MORE) {
                if (LispPrimitive.is(f, env)) {
                        if (!VAL && !LispPrimitive.seff(f)) {
                                return comp_seq(args, env, false, MORE);
                        }
                        return seq(comp_list(args, env),
                                   gen("PRIM", f, length(args)),
                                   VAL ? [] : gen("POP"),
                                   MORE ? [] : gen("RET"));
                }
                if (LC.is(f) && car(f) === S_LAMBDA && nullp(cadr(f))) {
                        assert(nullp(args), "Too many arguments");
                        return comp_seq(cddr(f), env, VAL, MORE);
                }
                if (MORE) {
                        var k = gen_label();
                        return seq(
                                gen("SAVE", k),
                                comp_list(args, env),
                                comp(f, env, true, true),
                                gen("CALL", length(args)),
                                [ k ],
                                VAL ? [] : gen("POP")
                        );
                }
                return seq(
                        comp_list(args, env),
                        comp(f, env, true, true),
                        gen("CALL", length(args))
                );
        };

        function comp_lambda(args, body, env) {
                if (LispSymbol.is(args)) {
                        return gen("FN",
                                   seq(gen("ARG_", 0),
                                       comp_seq(body, [ [ args ] ].concat(env), true, false)));
                } else {
                        var dot = LC.isDotted(args);
                        if (!dot) {
                                return gen("FN",
                                           seq(gen("ARGS", length(args)),
                                               comp_seq(body, [ LC.toArray(args) ].concat(env), true, false)));
                        }
                        var a = LC.toArray(args);
                        a.push([ a.pop(), a.pop() ][0]);
                        return gen("FN",
                                   seq(gen("ARG_", dot),
                                       comp_seq(body, [ a ].concat(env), true, false)));
                }
        };

        this.compile = function(x) {
                return comp_seq(x, [], true, false);
        };

        var INDENT_LEVEL = 8;

        function indent(level) {
                return repeat_string(' ', level * INDENT_LEVEL);
        };

        function show_code(x, level) {
                var ret = [];
                var line = "";
                var skip_indent = false;
                for (var i = 0; i < x.length; ++i) {
                        var el = x[i];
                        if (el instanceof LispLabel) {
                                line += pad_string(el.name + ":", level * INDENT_LEVEL);
                                skip_indent = true;
                                continue;
                        }
                        if (!skip_indent) line += indent(level);
                        skip_indent = false;
                        if (el[0] == "FN") {
                                line += "FN\n";
                                line += show_code(el[1], level + 1);
                        }
                        else {
                                line += el.map(function(el, i){
                                        if (i > 0) el = LispMachine.serialize_const(el);
                                        return pad_string(el, 8);
                                }).join("");
                        }
                        ret.push(line);
                        line = "";
                }
                return ret.join("\n");
        };

        this.comp_show = function(x) {
                return show_code(x, 1);
        };

})(LispCons);
