/// <reference types="tree-sitter-cli/dsl" />
// tree-sitter grammar for Harbour (and the Clipper / xBase dialect it compiles).
//
// Copyright (c) DeusData — MIT (the project's own license).
//
// Language reference: https://github.com/harbour/core (the compiler's own
// harbour.y / hbclass.ch / std.ch). The ANTLR4 HarbourLexer/HarbourParser from
// the "Harbour Language Analyzer" project (BSD, (c) 2018-2020 Alexey
// Zapolskiy) was used as a reading aid for the token set and statement forms;
// no text of it is carried here.
//
// Harbour source is what the programmer writes BEFORE the preprocessor runs,
// so this grammar models source files, not .ppo output:
//
//   * Statements are line based. A newline ends a statement, `;` at the end of
//     a line continues it (an extra), and `;` inside a line separates two
//     statements — exactly the Clipper rule.
//   * Keywords are case-insensitive and may be abbreviated to four letters
//     (`FUNC`, `RETU`, `ENDI`). They are regexes picked up by `word` keyword
//     extraction, so a keyword spelled where only a name is valid (`METHOD
//     end()`, `::delete()`) is an identifier.
//   * A FUNCTION/PROCEDURE/METHOD body has no end marker: it runs until the
//     next routine header. `STATIC FUNCTION`, `INIT PROCEDURE` and
//     `EXIT PROCEDURE` are single tokens so that a body's own `STATIC x` or
//     `EXIT` statement never has to be disambiguated from the next header.
//   * hbclass.ch syntax (CLASS ... ENDCLASS, METHOD ... CLASS x) is modelled
//     directly because nearly all Harbour OO code is written with it.
//   * Everything that is a user-defined #command (USE, SET ... TO, @ r,c SAY,
//     REPLACE ... WITH, ...) parses as a low-dynamic-precedence
//     command_statement, so the expressions inside it — and the calls they
//     contain — are still in the tree.
//   * #include / #define are structured nodes; the other directives
//     (#ifdef / #else / #endif / #command / #translate / #pragma ...) are extras
//     because they may appear between any two lines, including mid-class.
//     `#pragma BEGINDUMP ... #pragma ENDDUMP` (inline C) is one extra token
//     produced by src/scanner.c.

const PREC = {
  ASSIGN: 1,
  OR: 2,
  AND: 3,
  NOT: 4,
  EQUAL: 5,
  RELATIONAL: 6,
  ADD: 7,
  MULT: 8,
  POWER: 9,
  UNARY: 10,
  UPDATE: 11,
  REFERENCE: 12,
  ALIAS: 13,
  POSTFIX: 14,
  CALL: 15,
};

// Case-insensitive keyword regex source; letters past `min` are optional, so
// kwSource('FUNCTION', 4) accepts FUNC, FUNCT, ..., FUNCTION in any case.
function kwSource(word, min) {
  const m = min || word.length;
  let tail = '';
  for (let i = word.length - 1; i >= m; i--) {
    tail = '(' + word[i] + tail + ')?';
  }
  return word.slice(0, m) + tail;
}

function kw(word, min) {
  return alias(new RegExp(kwSource(word, min), 'i'), word.toLowerCase());
}

// Two keywords separated by blanks, lexed as ONE token (see header).
function kw2(first, firstMin, second, secondMin, name) {
  return alias(
    token(new RegExp(kwSource(first, firstMin) + '[ \\t]+' + kwSource(second, secondMin), 'i')),
    name,
  );
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}

function commaSep(rule) {
  return optional(commaSep1(rule));
}

// Comma list whose slots may be empty: Foo( a, , c ), { 1, , 3 }.
function sparseList(rule) {
  return seq(optional(rule), repeat(seq(',', optional(rule))));
}

module.exports = grammar({
  name: 'harbour',

  word: $ => $.identifier,

  externals: $ => [
    $._eof,
    $.dump_block,
    $.preproc_skipped,
    $._error_sentinel,
  ],

  extras: $ => [
    /[ \t\f\r]/,
    $.comment,
    $.line_continuation,
    $.preproc_directive,
    $.dump_block,
    $.preproc_skipped,
  ],

  conflicts: $ => [
    [$._argument, $.parenthesized_expression],
    [$.argument_list, $.function_reference],
    [$._command_expression, $.command_statement],
    [$.parenthesized_expression, $.if_expression],
  ],

  rules: {
    source_file: $ => repeat($._top_level_item),

    _top_level_item: $ => choice(
      $.function_definition,
      $.method_definition,
      $.class_definition,
      $._statement,
      $._blank_line,
    ),

    _blank_line: $ => choice($._newline, $._star_comment_line),

    // `*` in the first column of a statement is a comment in Clipper. It is
    // only lexed where a statement may start, so it never meets the `*`
    // operator.
    _star_comment_line: $ => alias(token(prec(-1, /\*[^\n]*/)), $.comment),

    _newline: _ => /\n/,

    _terminator: $ => choice($._newline, ';', $._eof),

    line_continuation: _ => token(seq(
      ';',
      repeat(choice(/[ \t\r]/, seq('/*', /[^*\n]*\*+([^/*\n][^*\n]*\*+)*/, '/'))),
      optional(choice(/\/\/[^\n]*/, /&&[^\n]*/)),
      '\n',
    )),

    comment: _ => token(choice(
      seq('//', /[^\n]*/),
      seq('&&', /[^\n]*/),
      seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    )),

    // ---------------------------------------------------------------- routines

    function_definition: $ => prec.right(seq(
      choice(
        kw('FUNCTION', 4),
        kw('PROCEDURE', 4),
        kw2('STATIC', 4, 'FUNCTION', 4, 'static_function'),
        kw2('STATIC', 4, 'PROCEDURE', 4, 'static_procedure'),
        kw2('INIT', 4, 'FUNCTION', 4, 'init_function'),
        kw2('INIT', 4, 'PROCEDURE', 4, 'init_procedure'),
        kw2('EXIT', 4, 'FUNCTION', 4, 'exit_function'),
        kw2('EXIT', 4, 'PROCEDURE', 4, 'exit_procedure'),
      ),
      field('name', $.identifier),
      optional(field('parameters', $.parameters)),
      optional(field('type', $.as_type)),
      // `PROCEDURE Name() CLASS Owner` implements a method, like METHOD does.
      optional(seq(kw('CLASS'), field('class', $.identifier))),
      $._terminator,
      optional(field('body', $.block)),
    )),

    // METHOD Name( params ) CLASS Owner   (hbclass.ch)
    // METHOD Owner:Name( params )        (Xbase++ style)
    method_definition: $ => prec.right(seq(
      choice(
        kw('METHOD', 4),
        kw2('METHOD', 4, 'FUNCTION', 4, 'method_function'),
        kw2('METHOD', 4, 'PROCEDURE', 4, 'method_procedure'),
      ),
      optional(seq(field('class', $.identifier), ':')),
      field('name', $.identifier),
      optional(field('parameters', $.parameters)),
      optional(field('type', $.as_type)),
      optional(seq(kw('CLASS'), field('class', $.identifier))),
      $._terminator,
      optional(field('body', $.block)),
    )),

    parameters: $ => seq(
      '(',
      optional(choice(
        seq(commaSep1($.parameter), optional(seq(',', '...'))),
        '...',
      )),
      ')',
    ),

    // prec(1): after `METHOD name` in a class body, `( a, b )` is the
    // parameter list, not a parenthesized member argument.
    parameter: $ => prec(1, seq(
      optional('@'),
      field('name', $.identifier),
      optional(field('type', $.as_type)),
    )),

    as_type: $ => prec.right(seq(
      kw('AS'),
      field('name', $.identifier),
      optional($.identifier),
    )),

    block: $ => prec.right(repeat1(choice($._statement, $._blank_line))),

    // ------------------------------------------------------------------ classes

    class_definition: $ => seq(
      optional(choice(kw('CREATE'), kw('STATIC', 4))),
      kw('CLASS'),
      field('name', $.identifier),
      repeat(choice(
        field('superclasses', $.superclass_list),
        $.class_option,
      )),
      $._terminator,
      optional(field('body', $.class_body)),
      choice(kw('ENDCLASS'), seq(kw('END'), kw('CLASS'))),
      $._terminator,
    ),

    superclass_list: $ => seq(
      choice(kw('FROM'), kw('INHERIT')),
      commaSep1($.identifier),
    ),

    // STATIC / FUNCTION <name> / METACLASS <name> ... after the class name.
    class_option: $ => prec.right(choice(
      kw('STATIC', 4),
      seq(kw('FUNCTION', 4), $.identifier),
      seq($.identifier, optional($.identifier)),
    )),

    class_body: $ => repeat1(choice(
      $.class_var_declaration,
      $.method_declaration,
      $.access_specifier,
      $.class_member_statement,
      $.preproc_include,
      $.preproc_define,
      $._blank_line,
    )),

    // VAR / DATA / CLASSVAR / CLASSDATA  a, b  [INIT x] [AS t] [EXPORTED] ...
    class_var_declaration: $ => seq(
      choice(kw('VAR'), kw('DATA'), kw('CLASSVAR'), kw('CLASSDATA')),
      commaSep1(field('name', $.identifier)),
      repeat($._member_argument),
      $._terminator,
    ),

    // METHOD / ACCESS / ASSIGN / MESSAGE  name[( params )]  [INLINE expr] ...
    method_declaration: $ => seq(
      choice(kw('METHOD', 4), kw('ACCESS'), kw('ASSIGN'), kw('MESSAGE')),
      field('name', $.identifier),
      optional(field('parameters', $.parameters)),
      repeat($._member_argument),
      $._terminator,
    ),

    // EXPORTED: / PROTECTED: / HIDDEN: / VISIBLE:
    access_specifier: $ => seq(field('name', $.identifier), ':', $._terminator),

    // CONSTRUCTOR x / ERROR HANDLER x / ON ERROR x / FRIEND ... / DELEGATE ...
    class_member_statement: $ => seq(
      field('name', $.identifier),
      repeat1($._member_argument),
      $._terminator,
    ),

    _member_argument: $ => prec(-1, choice(
      $._command_expression,
      $._command_operator,
      ':=',
      ',',
    )),

    // --------------------------------------------------------------- statements

    _statement: $ => choice(
      $.local_declaration,
      $.static_declaration,
      $.memvar_declaration,
      $.field_declaration,
      $.parameters_declaration,
      $.request_declaration,
      $.if_statement,
      $.do_case_statement,
      $.while_statement,
      $.for_statement,
      $.for_each_statement,
      $.switch_statement,
      $.begin_sequence_statement,
      $.try_statement,
      $.with_object_statement,
      $.return_statement,
      $.break_statement,
      $.exit_statement,
      $.loop_statement,
      $.do_statement,
      $.print_statement,
      $.preproc_include,
      $.preproc_define,
      $.expression_statement,
      $.command_statement,
    ),

    local_declaration: $ => seq(kw('LOCAL', 4), commaSep1($.variable_declarator), $._terminator),

    static_declaration: $ => seq(
      choice(kw('STATIC', 4), kw2('THREAD', 4, 'STATIC', 4, 'thread_static')),
      commaSep1($.variable_declarator),
      $._terminator,
    ),

    memvar_declaration: $ => seq(
      choice(kw('PRIVATE', 4), kw('PUBLIC', 4), kw('MEMVAR', 4)),
      commaSep1(choice($.variable_declarator, $.macro_variable, $.macro_expression)),
      $._terminator,
    ),

    field_declaration: $ => seq(
      $._field_keyword,
      commaSep1($.variable_declarator),
      optional(seq(kw('IN'), field('alias', $.identifier))),
      $._terminator,
    ),

    parameters_declaration: $ => seq(
      kw('PARAMETERS', 4),
      commaSep1($.variable_declarator),
      $._terminator,
    ),

    // REQUEST / EXTERNAL / ANNOUNCE / DYNAMIC name, ...
    request_declaration: $ => seq(
      choice(kw('REQUEST', 4), kw('EXTERNAL', 4), kw('ANNOUNCE', 4), kw('DYNAMIC')),
      commaSep1($.identifier),
      $._terminator,
    ),

    variable_declarator: $ => seq(
      field('name', $.identifier),
      optional(field('dimensions', $.dimensions)),
      optional(field('type', $.as_type)),
      optional(seq(choice(':=', '='), field('value', $._expression))),
    ),

    dimensions: $ => repeat1(seq('[', commaSep1($._expression), ']')),

    if_statement: $ => seq(
      kw('IF'),
      field('condition', $._expression),
      $._terminator,
      optional(field('consequence', $.block)),
      repeat(field('alternative', $.elseif_clause)),
      optional(field('alternative', $.else_clause)),
      choice(kw('ENDIF', 4), kw('END')),
      $._terminator,
    ),

    elseif_clause: $ => seq(
      kw('ELSEIF', 5),
      field('condition', $._expression),
      $._terminator,
      optional(field('body', $.block)),
    ),

    else_clause: $ => seq(kw('ELSE'), $._terminator, optional(field('body', $.block))),

    do_case_statement: $ => seq(
      kw('DO'), kw('CASE'),
      $._terminator,
      repeat($._blank_line),
      repeat($.case_clause),
      optional($.otherwise_clause),
      choice(kw('ENDCASE', 4), kw('END')),
      $._terminator,
    ),

    case_clause: $ => seq(
      kw('CASE'),
      field('condition', $._expression),
      $._terminator,
      optional(field('body', $.block)),
    ),

    otherwise_clause: $ => seq(
      kw('OTHERWISE', 4),
      $._terminator,
      optional(field('body', $.block)),
    ),

    while_statement: $ => seq(
      optional(kw('DO')),
      kw('WHILE', 4),
      field('condition', $._expression),
      $._terminator,
      optional(field('body', $.block)),
      choice(kw('ENDDO', 4), kw('ENDWHILE'), kw('END')),
      $._terminator,
    ),

    for_statement: $ => seq(
      kw('FOR'),
      field('variable', $._expression),
      choice(':=', '='),
      field('start', $._expression),
      kw('TO'),
      field('end', $._expression),
      optional(seq(kw('STEP'), field('step', $._expression))),
      $._terminator,
      optional(field('body', $.block)),
      $._for_end,
    ),

    for_each_statement: $ => seq(
      kw('FOR'), kw('EACH'),
      commaSep1(field('variable', choice($.identifier, $.reference, $.alias_expression))),
      kw('IN'),
      commaSep1(field('collection', $._argument)),
      optional(kw('DESCEND')),
      $._terminator,
      optional(field('body', $.block)),
      $._for_end,
    ),

    _for_end: $ => seq(
      choice(kw('NEXT'), kw('ENDFOR'), kw('END')),
      optional($.identifier),
      $._terminator,
    ),

    switch_statement: $ => seq(
      optional(kw('DO')),
      kw('SWITCH', 4),
      field('value', $._expression),
      $._terminator,
      repeat($._blank_line),
      repeat($.switch_case),
      optional($.otherwise_clause),
      choice(kw('ENDSWITCH', 5), seq(kw('END'), optional(kw('SWITCH', 4)))),
      $._terminator,
    ),

    switch_case: $ => seq(
      kw('CASE'),
      field('value', $._expression),
      $._terminator,
      optional(field('body', $.block)),
    ),

    begin_sequence_statement: $ => seq(
      kw('BEGIN', 4), kw('SEQUENCE', 4),
      optional(seq(kw('WITH'), field('handler', $._expression))),
      $._terminator,
      optional(field('body', $.block)),
      optional($.recover_clause),
      optional($.always_clause),
      choice(kw('ENDSEQUENCE', 6), seq(kw('END'), optional(kw('SEQUENCE', 4)))),
      $._terminator,
    ),

    recover_clause: $ => seq(
      kw('RECOVER', 4),
      optional(seq(kw('USING', 4), field('variable', $.identifier))),
      $._terminator,
      optional(field('body', $.block)),
    ),

    always_clause: $ => seq(kw('ALWAYS', 4), $._terminator, optional(field('body', $.block))),

    // xHarbour / hbcompat.ch TRY ... CATCH [e] ... FINALLY ... END
    try_statement: $ => seq(
      kw('TRY'),
      $._terminator,
      optional(field('body', $.block)),
      optional($.catch_clause),
      optional($.finally_clause),
      choice(kw('ENDTRY'), seq(kw('END'), optional(kw('TRY')))),
      $._terminator,
    ),

    catch_clause: $ => seq(
      kw('CATCH'),
      optional(field('variable', $.identifier)),
      $._terminator,
      optional(field('body', $.block)),
    ),

    finally_clause: $ => seq(kw('FINALLY'), $._terminator, optional(field('body', $.block))),

    with_object_statement: $ => seq(
      kw('WITH'), kw('OBJECT', 4),
      field('object', $._expression),
      $._terminator,
      optional(field('body', $.block)),
      choice(kw('ENDWITH', 4), seq(kw('END'), optional(kw('WITH')))),
      $._terminator,
    ),

    return_statement: $ => seq(kw('RETURN', 4), optional($._expression), $._terminator),

    break_statement: $ => seq(kw('BREAK', 4), optional($._expression), $._terminator),

    exit_statement: $ => seq(kw('EXIT'), $._terminator),

    loop_statement: $ => seq(kw('LOOP'), $._terminator),

    // DO <proc> [WITH <args>]  — a procedure call.
    do_statement: $ => seq(
      kw('DO'),
      field('function', choice($.identifier, $.macro_variable, $.macro_expression)),
      optional(seq(kw('WITH'), field('arguments', $.do_arguments))),
      $._terminator,
    ),

    do_arguments: $ => prec.right(choice(
      seq($._argument, repeat(seq(',', optional($._argument)))),
      seq(repeat1(seq(',', optional($._argument)))),
    )),

    // ? / ?? expression list (QOut / QQOut)
    print_statement: $ => seq(
      choice('?', '??'),
      commaSep($._expression),
      $._terminator,
    ),

    expression_statement: $ => seq($._expression, $._terminator),

    // Any user-defined #command. Lower dynamic precedence than every real
    // statement so it only wins when nothing else parses the line.
    command_statement: $ => prec.dynamic(-10, seq(
      field('name', choice($.identifier, '@')),
      repeat1($._command_argument),
      $._terminator,
    )),

    _command_argument: $ => prec(-1, choice(
      $._command_expression,
      $._command_operator,
      $.file_extension,
      ',',
    )),

    // `.dbf` in `USE test.dbf` — a file name is written bare in a command.
    file_extension: _ => /\.[A-Za-z_][A-Za-z0-9_]*/,

    // Expressions a command clause may hold. Bracket strings are excluded: in
    // `a[1] := x` the `[` must stay an index, never start a `[...]` string.
    _command_expression: $ => choice(
      $.identifier,
      $.number,
      $.string,
      $.date,
      $.logical,
      $.nil,
      $.macro_variable,
      $.macro_expression,
      $.call_expression,
      $.method_call,
      $.send_expression,
      $.self_send,
      $.index_expression,
      $.alias_expression,
      $.parenthesized_expression,
      $.array,
      $.hash,
      $.code_block,
    ),

    _command_operator: _ => choice(
      '=', '==', '!=', '<>', '#', '<', '>', '<=', '>=', '$',
      '+', '-', '*', '/', '%', '^', '**', '!', '->', '=>',
      /\.[aA][nN][dD]\./, /\.[oO][rR]\./, /\.[nN][oO][tT]\./,
    ),

    // ------------------------------------------------------------ preprocessor

    preproc_include: $ => seq(
      alias(token(prec(1, /#[ \t]*[iI][nN][cC][lL][uU][dD][eE]/)), '#include'),
      field('path', $.string),
      $._terminator,
    ),

    preproc_define: $ => seq(
      alias(token(prec(1, /#[ \t]*[dD][eE][fF][iI][nN][eE]/)), '#define'),
      field('name', $.identifier),
      optional(field('value', $.preproc_arg)),
      $._terminator,
    ),

    // The macro body, raw; `;` at end of line continues it like any other line.
    preproc_arg: _ => token(prec(-1, seq(
      /[^ \t\n\/]|\/[^\/*\n]/,
      repeat(choice(/[^\n;\/]/, /\/[^\/*\n]/, /;[ \t\r]*\n/, ';')),
    ))),

    // Every other directive, one line (plus `;` continuations for #command).
    // A known directive may have blanks after `#`; any other `#word` (e.g.
    // #require) must not, so `a # b` (not-equal) is never read as one.
    // #include / #define carry lexical precedence so this never swallows them.
    preproc_directive: _ => token(seq(
      choice(
        seq('#', /[ \t]*/, /(if|ifdef|ifndef|elif|else|endif|undef|pragma|error|warning|stdout|line|require|x?command|x?translate|yy?command|yy?translate|x?uncommand|x?untranslate)/i),
        /#[A-Za-z_]+/,
      ),
      repeat(choice(/[^\n;\/]/, /\/[^\/*\n]/, /;[ \t\r]*\n/, ';')),
    )),

    // -------------------------------------------------------------- expressions

    _expression: $ => choice(
      $.assignment_expression,
      $.binary_expression,
      $.unary_expression,
      $.update_expression,
      $._primary_expression,
    ),

    assignment_expression: $ => prec.right(PREC.ASSIGN, seq(
      field('left', $._expression),
      field('operator', choice(':=', '+=', '-=', '*=', '/=', '%=', '^=', '**=')),
      field('right', $._expression),
    )),

    binary_expression: $ => {
      const table = [
        [PREC.OR, alias(/\.[oO][rR]\./, '.OR.')],
        [PREC.AND, alias(/\.[aA][nN][dD]\./, '.AND.')],
        [PREC.EQUAL, choice('=', '==', '!=', '<>', '#')],
        [PREC.RELATIONAL, choice('<', '>', '<=', '>=', '$')],
        [PREC.ADD, choice('+', '-')],
        [PREC.MULT, choice('*', '/', '%')],
        [PREC.POWER, choice('^', '**')],
      ];
      return choice(...table.map(([p, op]) => prec.left(p, seq(
        field('left', $._expression),
        field('operator', op),
        field('right', $._expression),
      ))));
    },

    unary_expression: $ => choice(
      prec(PREC.NOT, seq(field('operator', choice('!', alias(/\.[nN][oO][tT]\./, '.NOT.'))), field('argument', $._expression))),
      prec(PREC.UNARY, seq(field('operator', choice('-', '+')), field('argument', $._expression))),
    ),

    update_expression: $ => prec.left(PREC.UPDATE, choice(
      seq(field('operator', choice('++', '--')), field('argument', $._expression)),
      seq(field('argument', $._expression), field('operator', choice('++', '--'))),
    )),

    _primary_expression: $ => choice(
      $._command_expression,
      $._implicit_send,
      $.bracket_string,
      $.if_expression,
      $.function_reference,
      $.variadic,
    ),

    // What a postfix operator (: [ ]) may apply to. Never a `[...]` string,
    // so `a[1]` after an identifier is always an index.
    _postfix_object: $ => choice(
      $._command_expression,
      $._implicit_send,
      $.if_expression,
    ),

    call_expression: $ => prec(PREC.CALL, seq(
      field('function', choice($.identifier, $.macro_variable, $.macro_expression)),
      field('arguments', $.argument_list),
    )),

    argument_list: $ => seq('(', sparseList($._argument), ')'),

    // `@x` / `@Func()` is only meaningful where a value is passed on, so it is
    // admitted there and nowhere else — at statement start `@` is the
    // `@ row, col SAY ...` command.
    _argument: $ => choice($._expression, $.reference),

    // obj:msg( args ) / ::msg( args ) / :msg( args ) (inside WITH OBJECT)
    method_call: $ => prec(PREC.CALL, seq(
      choice(
        seq(field('object', $._postfix_object), ':'),
        $.self_reference,
      ),
      field('name', $._message),
      field('arguments', $.argument_list),
    )),

    // :msg / :msg( args ) — the implicit object of WITH OBJECT. Kept out of
    // command arguments, where `x :msg` would otherwise also read as `x:msg`.
    _implicit_send: $ => prec(PREC.POSTFIX, choice(
      alias(seq(':', field('name', $._message), field('arguments', $.argument_list)), $.method_call),
      alias(seq(':', field('name', $._message)), $.self_send),
    )),

    send_expression: $ => prec(PREC.POSTFIX, seq(
      field('object', $._postfix_object),
      ':',
      field('name', $._message),
    )),

    // ::var  — a message sent to Self, or :var inside WITH OBJECT.
    self_send: $ => prec(PREC.POSTFIX, seq(
      $.self_reference,
      field('name', $._message),
    )),

    self_reference: _ => '::',

    _message: $ => choice($.identifier, $.macro_variable, $.macro_expression),

    index_expression: $ => prec(PREC.POSTFIX, seq(
      field('object', $._postfix_object),
      '[',
      commaSep1(field('index', $._expression)),
      ']',
    )),

    // alias->field, (nArea)->( dbSkip() ), FIELD->name, M->var
    alias_expression: $ => prec.left(PREC.ALIAS, seq(
      field('alias', choice($.identifier, $.number, $.parenthesized_expression, $.macro_variable, $.macro_expression, alias($._field_keyword, $.identifier), alias(kw('MEMVAR', 4), $.identifier))),
      '->',
      field('field', choice($.identifier, $.parenthesized_expression, $.macro_variable, $.macro_expression)),
    )),

    _field_keyword: _ => alias(/_?[fF][iI][eE][lL][dD]?/, 'field'),

    // @var — pass by reference (@Func() is function_reference)
    reference: $ => seq('@', choice(
      $.identifier,
      $.alias_expression,
      $.macro_variable,
      $.send_expression,
      $.self_send,
      $.index_expression,
    )),

    // @Func() — a function pointer; valid wherever a value is.
    function_reference: $ => seq('@', field('name', $.identifier), '(', ')'),

    // IF( cond, a, b ) used as an expression (IIF is an ordinary call).
    if_expression: $ => seq(
      kw('IF'),
      '(',
      field('condition', $._expression),
      ',',
      optional(field('consequence', $._expression)),
      ',',
      optional(field('alternative', $._expression)),
      ')',
    ),

    parenthesized_expression: $ => seq('(', commaSep1($._expression), ')'),

    array: $ => seq('{', sparseList($._argument), '}'),

    hash: $ => seq('{', choice('=>', commaSep1($.hash_pair)), '}'),

    hash_pair: $ => seq(field('key', $._expression), '=>', optional(field('value', $._expression))),

    // {| params | expr, expr }  or the multi-line extended form
    // {| params |
    //    <statements>
    // }
    code_block: $ => seq(
      '{', '|',
      optional(field('parameters', $.block_parameters)),
      '|',
      optional(choice(
        commaSep1($._expression),
        seq($._newline, optional(field('body', $.block))),
      )),
      '}',
    ),

    block_parameters: $ => choice(
      seq(commaSep1($.parameter), optional(seq(',', '...'))),
      '...',
    ),

    // `...` passed on as an argument list: Foo( ... ), { ... }
    variadic: _ => prec(-1, '...'),

    macro_variable: _ => /&[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]*)?/,

    macro_expression: $ => seq('&', '(', $._expression, ')'),

    // ----------------------------------------------------------------- literals

    // Before `identifier`: keyword extraction only considers tokens that
    // precede the word token in rule order.
    nil: _ => kw('NIL'),

    identifier: _ => /[A-Za-z_][A-Za-z0-9_]*/,

    number: _ => token(choice(
      /0[xX][0-9a-fA-F]+/,
      /[0-9]+(\.[0-9]+)?/,
      /\.[0-9]+/,
    )),

    string: _ => token(choice(
      /"[^"\n]*"/,
      /'[^'\n]*'/,
      /[eE]"([^"\\\n]|\\.)*"/,
    )),

    bracket_string: _ => /\[[^\]\n]*\]/,

    date: _ => token(choice(
      /0[dD][0-9]+/,
      /[dD]"[^"\n]*"/,
      /[tT]"[^"\n]*"/,
    )),

    logical: _ => token(/\.[tTfFyYnN]\./),

  },
});
