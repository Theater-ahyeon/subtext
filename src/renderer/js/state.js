'use strict';
/* 演练 · 全局状态（唯一可变共享对象，视图模块经 HB.state 引用） */
(() => {
  const HB = (window.HB = window.HB || {});
  HB.state = {
    persons: [],
    currentId: null,
    currentName: '',
    view: 'home',
    session: null,       // {id, messages: [], readonly?}
    sessionScenario: '',
    sessionGoal: '',
    predictions: [],
    importPreview: null,
    settings: null,
    interview: null,
  };
})();
