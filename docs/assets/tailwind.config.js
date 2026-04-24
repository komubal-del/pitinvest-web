tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Pretendard', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        toss: {
          blue:    '#3182F6',
          blueL:   '#E8F2FF',
          dark:    '#191F28',
          text:    '#4E5968',
          sub:     '#8B95A1',
          border:  '#E5E8EB',
          bg:      '#F2F4F6',
          card:    '#FFFFFF',
          green:   '#00BF5C',
          greenL:  '#E6F9F0',
          yellow:  '#FFB900',
          yellowL: '#FFF7DB',
          red:     '#F04452',
          redL:    '#FEE7E9',
          purple:  '#8B5CF6',
          purpleL: '#EEE9FE',
          orange:  '#F97316',
          orangeL: '#FFEDD5',
        }
      },
      boxShadow: {
        toss:      '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)',
        tossHover: '0 4px 12px rgba(0,0,0,0.08)',
      },
      borderRadius: {
        toss:   '16px',
        tossLg: '20px',
      }
    }
  }
};
