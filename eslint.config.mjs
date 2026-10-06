// Линтер ищет ошибки, форматтер правит вид: правила оформления у ESLint выключены,
// иначе оба спорят за одну строку и правки «плавают».
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-tauri/**',
      '**/src-tauri/**',
      'packages/core/tests/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  // Vue-правила и правила TS живут в разных слоях: включение TS-конфига глобально
  // тянет линтер на .vue и .json, где typescript-eslint нечего проверять.
  {
    // Конфиги plugin-vue 10 больше не объявляют браузерные globals (#2674):
    // без этого window, setTimeout и прочее вспыхивают как no-undef в .vue.
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      globals: { ...globals.browser },
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: { parser: tseslint.parser },
  },

  {
    // Константы из define в vite.config.ts объявлены в src/vite-env.d.ts, но ESLint
    // .d.ts не подтягивает: перечисляем те же имена явно.
    files: ['**/*.{ts,vue,mts,cts}'],
    languageOptions: {
      globals: {
        __ANIMORI_PLATFORM__: 'readonly',
        __ANIMORI_VERSION__: 'readonly',
        __ANIMORI_SHELL_CAN__: 'readonly',
      },
    },
  },

  {
    // Скрипты запускает Node, а не браузер: там process, __dirname и Buffer законны.
    files: ['scripts/**', '**/*.mjs', '**/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    rules: {
      // Неиспользуемое ловит tsc (noUnusedLocals), а здесь это даёт вдвое больше
      // шума на параметрах, переиспользуемых ради подписи в шаблоне.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_|^event$|^_$' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',

      // Vue: правила оформления шаблона — это мнение о вкусе, а не ошибка.
      // Порядок атрибутов и самозакрывающиеся теги оставлены Prettier.
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/attributes-order': 'off',

      // ignoreReadBeforeAssign: в db.ts таймер читают в колбэке до присваивания —
      // let там законен, и такие же места есть в коде.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },

  {
    // Тесты и конфиги живут по своим правилам: моки не проходят настоящие типы,
    // а в конфигах Vite-специфика намеренные предупреждения о loader.
    files: ['**/tests/**', '**/*.test.ts', '**/vite.config.ts', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Последним: гасит правила ESLint, которые спорят с Prettier за форматирование.
  prettier,
)
