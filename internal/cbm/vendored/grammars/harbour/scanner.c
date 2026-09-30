// External scanner for tree-sitter-harbour.
//
// Copyright (c) DeusData - MIT (the project's own license).
//
// Three tokens the regex lexer cannot express:
//
//   _eof        A zero-width statement terminator at end of input, so a file
//               whose last line has no trailing newline still parses. Emitted
//               only when a terminator is actually expected (never in the
//               blank-line repeat), so it can never loop.
//
//   dump_block  `#pragma BEGINDUMP` ... `#pragma ENDDUMP`: inline C embedded
//               in a .prg file. The body is arbitrary C, so it is consumed as
//               one opaque extra up to and including the ENDDUMP line. A
//               regular expression would need "shortest match up to a
//               keyword", which tree-sitter's longest-match lexer cannot do.
//
//   preproc_skipped
//               The inactive half of a conditional: from `#else` / `#elif` to
//               the matching `#endif`, and the body of `#if 0`. Source is
//               written for the preprocessor, and the two branches of an
//               #ifdef routinely each open the same block (`IF a .OR. b` /
//               `IF b`) that one shared `ENDIF` closes. Parsing both halves
//               leaves an unbalanced block that swallows the rest of the file,
//               so only the first branch is parsed - the one the compiler sees
//               when the symbol is defined. Nested conditionals inside a
//               skipped region are balanced by depth.
//
// The scanner is stateless.

#include "tree_sitter/parser.h"

#include <stdbool.h>

enum TokenType {
    EOF_TERMINATOR,
    DUMP_BLOCK,
    PREPROC_SKIPPED,
    ERROR_SENTINEL,
};

enum { DIRECTIVE_MAX = 16 };

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool is_blank(int32_t c) { return c == ' ' || c == '\t' || c == '\f' || c == '\r'; }

static inline int32_t lower(int32_t c) { return (c >= 'A' && c <= 'Z') ? c + ('a' - 'A') : c; }

// Consume `word` case-insensitively. False (with a partial advance) on mismatch;
// the caller then returns false, which discards the advance.
static bool match_word(TSLexer *lexer, const char *word) {
    for (const char *w = word; *w; w++) {
        if (lower(lexer->lookahead) != *w) {
            return false;
        }
        advance(lexer);
    }
    return true;
}

static void skip_blanks(TSLexer *lexer) {
    while (is_blank(lexer->lookahead)) {
        advance(lexer);
    }
}

// At the start of a line (after leading blanks): is this `#pragma <word>`?
// Consumes what it reads.
static bool match_pragma(TSLexer *lexer, const char *word) {
    if (lexer->lookahead != '#') {
        return false;
    }
    advance(lexer);
    skip_blanks(lexer);
    if (!match_word(lexer, "pragma")) {
        return false;
    }
    if (!is_blank(lexer->lookahead)) {
        return false;
    }
    skip_blanks(lexer);
    return match_word(lexer, word);
}

// Called just after `#pragma BEGINDUMP`.
static bool scan_dump_body(TSLexer *lexer) {
    // Consume lines until one reads `#pragma ENDDUMP`. An unterminated dump
    // runs to end of file, which is what the Harbour compiler does too.
    for (;;) {
        while (lexer->lookahead != '\n' && !lexer->eof(lexer)) {
            advance(lexer);
        }
        lexer->mark_end(lexer);
        if (lexer->eof(lexer)) {
            break;
        }
        advance(lexer); // '\n'
        skip_blanks(lexer);
        if (match_pragma(lexer, "enddump")) {
            while (lexer->lookahead != '\n' && !lexer->eof(lexer)) {
                advance(lexer);
            }
            lexer->mark_end(lexer);
            break;
        }
    }
    lexer->result_symbol = DUMP_BLOCK;
    return true;
}

// Read `#` + blanks + a directive word (lower-cased into buf). Consumes it.
static bool read_directive(TSLexer *lexer, char *buf) {
    if (lexer->lookahead != '#') {
        return false;
    }
    advance(lexer);
    skip_blanks(lexer);
    int n = 0;
    while (n < DIRECTIVE_MAX - 1 && ((lower(lexer->lookahead) >= 'a' && lower(lexer->lookahead) <= 'z'))) {
        buf[n++] = (char)lower(lexer->lookahead);
        advance(lexer);
    }
    buf[n] = '\0';
    return n > 0;
}

static bool is_if_directive(const char *d) {
    return d[0] == 'i' && d[1] == 'f' &&
           (d[2] == '\0' || (d[2] == 'd' && d[3] == 'e' && d[4] == 'f' && d[5] == '\0') ||
            (d[2] == 'n' && d[3] == 'd' && d[4] == 'e' && d[5] == 'f' && d[6] == '\0'));
}

static bool str_eq(const char *a, const char *b) {
    while (*a && *a == *b) {
        a++;
        b++;
    }
    return *a == *b;
}

static void skip_to_eol(TSLexer *lexer) {
    while (lexer->lookahead != '\n' && !lexer->eof(lexer)) {
        advance(lexer);
    }
}

// Consume whole lines until the directive that closes the current conditional
// at depth 0. `stop_at_else` also closes on #else/#elif (the `#if 0` case: the
// #else branch is live). The closing directive's line is consumed.
static void skip_conditional(TSLexer *lexer, bool stop_at_else) {
    int depth = 0;
    for (;;) {
        skip_to_eol(lexer);
        lexer->mark_end(lexer);
        if (lexer->eof(lexer)) {
            return;
        }
        advance(lexer); // '\n'
        skip_blanks(lexer);
        char d[DIRECTIVE_MAX];
        if (!read_directive(lexer, d)) {
            continue;
        }
        if (is_if_directive(d)) {
            depth++;
        } else if (str_eq(d, "endif")) {
            if (depth == 0) {
                skip_to_eol(lexer);
                lexer->mark_end(lexer);
                return;
            }
            depth--;
        } else if (stop_at_else && depth == 0 && (str_eq(d, "else") || str_eq(d, "elif"))) {
            skip_to_eol(lexer);
            lexer->mark_end(lexer);
            return;
        }
    }
}

// Called at `#`. Emits PREPROC_SKIPPED for `#else`/`#elif ... #endif` and for
// `#if 0 ... (#else|#endif)`; anything else is left to the regex lexer.
static bool scan_directive(TSLexer *lexer, const bool *valid_symbols) {
    char d[DIRECTIVE_MAX];
    if (!read_directive(lexer, d)) {
        return false;
    }
    if (valid_symbols[DUMP_BLOCK] && str_eq(d, "pragma")) {
        if (!is_blank(lexer->lookahead)) {
            return false;
        }
        skip_blanks(lexer);
        if (!match_word(lexer, "begindump")) {
            return false;
        }
        return scan_dump_body(lexer);
    }
    if (!valid_symbols[PREPROC_SKIPPED]) {
        return false;
    }
    if (str_eq(d, "else") || str_eq(d, "elif")) {
        skip_conditional(lexer, false);
        lexer->result_symbol = PREPROC_SKIPPED;
        return true;
    }
    if (str_eq(d, "if")) {
        skip_blanks(lexer);
        if (lexer->lookahead != '0') {
            return false;
        }
        advance(lexer);
        skip_blanks(lexer);
        if (lexer->lookahead != '\n' && lexer->lookahead != '\r' && !lexer->eof(lexer) &&
            lexer->lookahead != '/') {
            return false; // `#if 0x10 ...` or `#if 0 + x`: not a literal 0
        }
        skip_conditional(lexer, true);
        lexer->result_symbol = PREPROC_SKIPPED;
        return true;
    }
    return false;
}

void *tree_sitter_harbour_external_scanner_create(void) { return NULL; }

void tree_sitter_harbour_external_scanner_destroy(void *payload) { (void)payload; }

unsigned tree_sitter_harbour_external_scanner_serialize(void *payload, char *buffer) {
    (void)payload;
    (void)buffer;
    return 0;
}

void tree_sitter_harbour_external_scanner_deserialize(void *payload, const char *buffer,
                                                      unsigned length) {
    (void)payload;
    (void)buffer;
    (void)length;
}

bool tree_sitter_harbour_external_scanner_scan(void *payload, TSLexer *lexer,
                                               const bool *valid_symbols) {
    (void)payload;
    // Error recovery marks every token valid; never invent tokens there.
    if (valid_symbols[ERROR_SENTINEL]) {
        return false;
    }
    while (is_blank(lexer->lookahead)) {
        skip(lexer);
    }
    if (lexer->eof(lexer)) {
        if (valid_symbols[EOF_TERMINATOR]) {
            lexer->result_symbol = EOF_TERMINATOR;
            return true;
        }
        return false;
    }
    if (lexer->lookahead == '#') {
        return scan_directive(lexer, valid_symbols);
    }
    return false;
}
